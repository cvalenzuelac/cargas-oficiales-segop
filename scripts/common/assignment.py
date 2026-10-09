"""Asignación persistente de vuelos a validadores (la usa push_source.py; el estado
vive en Cloudflare). Casos de prueba en fixtures/assignment_cases.json.

Entrada:
- tasks: tareas de la fuente (una por vuelo). Usa sourceId, labels (tipos de
  evento), extra.openEvents (carga: eventos abiertos dentro de la ventana) y
  extra.olderOpenEvents (abiertos más antiguos que la ventana; no son carga).
- previous: {flightId: {"owner": correo, "since": ISO}} de la ingesta anterior.
- config: {"validators": [{email, name?, active?, capacity?}],
           "restrictions": {"<tipo de evento>": [correos habilitados]}}

Reglas:
0. Matrículas dedicadas (config.registrationOwners): sus vuelos siempre van a esa
   persona y le cuentan como carga; si esa persona no está activa, conflicto. Esa
   persona solo gestiona sus matrículas: no recibe ni conserva vuelos de otras.
1. Un vuelo con dueño lo conserva mientras tenga eventos abiertos en la ventana
   y su dueño siga activo y habilitado para todos sus tipos de evento. La carga
   ya atribuida no se redistribuye: solo se reparten los vuelos nuevos.
2. Los demás vuelos con eventos abiertos se reparten. Orden: mayor carga
   primero, desempate por id. Cada uno va al validador habilitado que quede con
   menor (carga + carga del vuelo) / capacidad, donde carga = baseline (trabajo
   hecho en la ventana + Planner ponderado) + eventos pendientes ya asignados;
   empate -> mayor
   fnv1a32(id|correo), luego correo. Determinista. (La regla de desempate no
   depende del orden de los validadores en la configuración.)
3. Sin validador habilitado -> conflicto.
4. Vuelos sin eventos en la ventana: se liberan (gestionados o solo con eventos
   antiguos). Los que tienen olderOpenEvents son rezagados: lista aparte.
"""

from __future__ import annotations

from typing import Any


class AssignmentConfigError(ValueError):
    pass


def fnv1a32(text: str) -> int:
    """Hash FNV-1a de 32 bits (mismo resultado que la versión JS con Math.imul)."""
    h = 0x811C9DC5
    for ch in text:
        h ^= ord(ch)
        h = (h * 16777619) & 0xFFFFFFFF
    return h


def _is_number(value: Any) -> bool:
    return isinstance(value, (int, float)) and not isinstance(value, bool)


def normalize_config(config: Any) -> dict[str, Any]:
    """Valida y normaliza la configuración. Lanza AssignmentConfigError si es inválida."""
    if not isinstance(config, dict):
        raise AssignmentConfigError("assignment debe ser un objeto")
    raw_validators = config.get("validators")
    if not isinstance(raw_validators, list):
        raise AssignmentConfigError("assignment.validators debe ser una lista")

    validators = []
    seen: set[str] = set()
    for i, item in enumerate(raw_validators):
        where = f"assignment.validators[{i}]"
        if not isinstance(item, dict):
            raise AssignmentConfigError(f"{where} debe ser un objeto")
        email = item.get("email")
        if not isinstance(email, str) or "@" not in email:
            raise AssignmentConfigError(f"{where}.email debe ser un correo")
        email = email.strip().lower()
        if email in seen:
            raise AssignmentConfigError(f"{where}.email repetido: {email}")
        seen.add(email)
        name = item.get("name")
        if name is not None and not isinstance(name, str):
            raise AssignmentConfigError(f"{where}.name debe ser texto")
        active = item.get("active", True)
        if not isinstance(active, bool):
            raise AssignmentConfigError(f"{where}.active debe ser true o false")
        capacity = item.get("capacity", 1)
        if not _is_number(capacity) or capacity < 0:
            raise AssignmentConfigError(f"{where}.capacity debe ser un número >= 0")
        validators.append({"email": email, "name": (name or "").strip() or None, "active": active, "capacity": capacity})

    raw_restrictions = config.get("restrictions")
    if raw_restrictions is None:
        raw_restrictions = {}
    if not isinstance(raw_restrictions, dict):
        raise AssignmentConfigError("assignment.restrictions debe ser un objeto")
    restrictions: dict[str, list[str]] = {}
    for event_type, emails in raw_restrictions.items():
        if not isinstance(emails, list) or not all(isinstance(e, str) for e in emails):
            raise AssignmentConfigError(f'assignment.restrictions["{event_type}"] debe ser una lista de correos')
        restrictions[event_type] = sorted({e.strip().lower() for e in emails})

    # Matrículas dedicadas: sus vuelos siempre van a esa persona (y le cuentan como carga).
    raw_owners = config.get("registrationOwners")
    if raw_owners is None:
        raw_owners = {}
    if not isinstance(raw_owners, dict):
        raise AssignmentConfigError("assignment.registrationOwners debe ser un objeto")
    registration_owners: dict[str, str] = {}
    for registration, email in raw_owners.items():
        where = f'assignment.registrationOwners["{registration}"]'
        if not isinstance(email, str) or email.strip().lower() not in seen:
            raise AssignmentConfigError(f"{where} debe ser el correo de un validador de la lista")
        registration_owners[registration.strip().upper()] = email.strip().lower()

    return {"validators": validators, "restrictions": restrictions, "registrationOwners": registration_owners}


def _flight_load(task: dict[str, Any]) -> int:
    value = (task.get("extra") or {}).get("openEvents")
    return int(value) if _is_number(value) and value > 0 else 0


def _older_load(task: dict[str, Any]) -> int:
    value = (task.get("extra") or {}).get("olderOpenEvents")
    return int(value) if _is_number(value) and value > 0 else 0


def _better(ratio: float, fid: str, email: str, best_ratio: float, best_email: str, best_hash: list[int | None]) -> bool:
    """¿(ratio, email) le gana al mejor actual? Empate de ratio -> mayor hash, luego correo.
    El hash se calcula solo en empates (best_hash es una caché de una posición)."""
    if ratio != best_ratio:
        return ratio < best_ratio
    if best_hash[0] is None:
        best_hash[0] = fnv1a32(f"{fid}|{best_email}")
    h = fnv1a32(f"{fid}|{email}")
    if h != best_hash[0]:
        return h > best_hash[0]
    return email < best_email


def assign_flights(
    tasks: list[dict[str, Any]],
    previous: dict[str, Any] | None,
    config: dict[str, Any],
    now: str,
    baseline: dict[str, float] | None = None,
) -> dict[str, Any]:
    """Devuelve {"owners", "summary"}. `config` debe venir de normalize_config.

    baseline: carga previa por correo, en eventos equivalentes (trabajo hecho en la
    ventana + Planner; ver common/workload.py). El reparto iguala baseline + eventos
    pendientes de Sara; sin baseline, iguala solo los eventos pendientes.

    owners: {flightId: {"owner", "since"}}. Las tareas no se modifican: quien
    muestre los datos aplica los dueños (public/js/lib/dataset.js)."""
    previous = previous or {}
    baseline = baseline or {}
    validators = config["validators"]
    restrictions = config["restrictions"]
    registration_owners = config.get("registrationOwners") or {}
    dedicated_emails = set(registration_owners.values())
    active_all = [v for v in validators if v["active"] and v["capacity"] > 0]
    active_emails = {v["email"] for v in active_all}
    loads = {v["email"]: baseline.get(v["email"], 0) for v in active_all}
    # Quien tiene matrículas dedicadas solo gestiona esas: no entra al reparto general.
    active = [v for v in active_all if v["email"] not in dedicated_emails]

    def eligible(types: list[str]) -> list[dict[str, Any]]:
        allowed: set[str] | None = None
        for event_type in types:
            listed = restrictions.get(event_type)
            if not listed:
                continue
            allowed = set(listed) if allowed is None else allowed & set(listed)
        return active if allowed is None else [v for v in active if v["email"] in allowed]

    flights = [(t["sourceId"], _flight_load(t), t) for t in tasks]
    backlog = [_older_load(t) for _, load, t in flights if load == 0 and _older_load(t) > 0]
    flights = [f for f in flights if f[1] > 0]
    flights.sort(key=lambda f: (-f[1], f[0]))

    owners: dict[str, dict[str, str]] = {}
    pending: list[tuple[str, int, list[dict[str, Any]], bool]] = []
    kept = assigned = reassigned = 0
    conflicts: list[str] = []
    for fid, load, task in flights:
        prev = previous.get(fid)
        prev_owner = prev.get("owner") if isinstance(prev, dict) else None
        dedicated = registration_owners.get(str((task.get("extra") or {}).get("registration") or "").upper())
        if dedicated:
            # Matrícula dedicada: siempre a esa persona; si no está activa, conflicto.
            if dedicated not in active_emails:
                conflicts.append(fid)
                continue
            if prev_owner == dedicated:
                owners[fid] = {"owner": dedicated, "since": prev.get("since") or now}
                kept += 1
            else:
                owners[fid] = {"owner": dedicated, "since": now}
                if prev_owner:
                    reassigned += 1
                else:
                    assigned += 1
            loads[dedicated] += load
            continue
        candidates = eligible(task.get("labels") or []) if restrictions else active
        if prev_owner and any(v["email"] == prev_owner for v in candidates):
            owners[fid] = {"owner": prev_owner, "since": prev.get("since") or now}
            loads[prev_owner] += load
            kept += 1
        else:
            pending.append((fid, load, candidates, bool(prev_owner)))

    for fid, load, candidates, had_owner in pending:
        if not candidates:
            conflicts.append(fid)
            continue
        best = candidates[0]
        best_ratio = (loads[best["email"]] + load) / best["capacity"]
        best_hash: list[int | None] = [None]
        for v in candidates[1:]:
            ratio = (loads[v["email"]] + load) / v["capacity"]
            if _better(ratio, fid, v["email"], best_ratio, best["email"], best_hash):
                best, best_ratio, best_hash = v, ratio, [None]
        owners[fid] = {"owner": best["email"], "since": now}
        loads[best["email"]] += load
        if had_owner:
            reassigned += 1
        else:
            assigned += 1

    present = {f[0] for f in flights}
    released = sum(1 for fid in previous if fid not in present)

    flights_of: dict[str, int] = {}
    events_of: dict[str, int] = {}
    for fid, load, _task in flights:
        owner = owners.get(fid)
        if owner:
            flights_of[owner["owner"]] = flights_of.get(owner["owner"], 0) + 1
            events_of[owner["owner"]] = events_of.get(owner["owner"], 0) + load

    summary = {
        "validators": [
            {
                "email": v["email"],
                "name": v["name"],
                "active": v["active"],
                "capacity": v["capacity"],
                "flights": flights_of.get(v["email"], 0),
                "openEvents": events_of.get(v["email"], 0),
                # carga justa = carga previa + eventos pendientes asignados
                "baseline": round(baseline.get(v["email"], 0), 4),
                "workload": round(baseline.get(v["email"], 0) + events_of.get(v["email"], 0), 4),
                "restrictedTypes": sorted(t for t, emails in restrictions.items() if v["email"] in emails),
                "registrations": sorted(r for r, email in registration_owners.items() if email == v["email"]),
            }
            for v in validators
        ],
        "conflicts": conflicts,
        # rezagados: vuelos cuyos eventos abiertos son todos anteriores a la ventana
        "backlog": {"flights": len(backlog), "olderOpenEvents": sum(backlog)},
        "counts": {"kept": kept, "assigned": assigned, "reassigned": reassigned, "released": released},
    }
    return {"owners": owners, "summary": summary}
