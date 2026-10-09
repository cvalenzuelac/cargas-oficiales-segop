"""Adaptador de la fuente `sara`: eventos de severidad alta exportados por la API de Sara
(dataset @EventsL12M: vuelos de los últimos ~12 meses).

Cada fila es un evento. Interesan:
- Eventos ABIERTOS: isopen = True y fecha (eventdate, o takeoffdate si falta) dentro
  de los últimos `windowDays` (180) días. Se agrupan por vuelo; cada vuelo es una Task
  (la unidad de asignación) y su carga es su número de eventos abiertos. Los isopen más
  antiguos se informan aparte (olderOpenEvents) para la lista de rezagados.
- Eventos GESTIONADOS: isopen = False, con lastmodifiedby (correo) y ModificationDate
  dentro de los últimos `workWindowDays` (7) días. Son el trabajo hecho por cada persona.
  Si ModificationDate viene vacía, se usa la fecha del evento (eventdate, o takeoffdate
  si falta) + 1 día.

La carga de trabajo por persona (ver common/workload.py) combina lo anterior con las
tareas de Planner ponderadas por etiqueta (options.plannerTasks + plannerWeights).

Fechas: formato mm/dd/yyyy hh:mm:ss en UTC. Columnas sin distinguir mayúsculas.
Cuentas sin "@" en lastmodifiedby son cuentas del sistema: no cuentan como personas.

Opciones (config.json -> sources.sara.options):
    windowDays       días hacia atrás para que un evento abierto cuente (180)
    workWindowDays   ventana del trabajo hecho para la carga justa (7)
    plannerSource    fuente de config.json con las tareas de Planner (la lee push_source.py)
    plannerWeights   {"<etiqueta>": eventos equivalentes}
    team             correos de las personas que muestra el dashboard (si falta: todas)
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone
from typing import Any

from adapters import AdapterError, AdapterResult, make_task, make_warning
from common.assignment import AssignmentConfigError, normalize_config
from common.workload import planner_work

REQUIRED_COLUMNS = (
    "flightid",
    "takeoffdate",
    "originicao",
    "destinationicao",
    "registration",
    "eventid",
    "eventdate",
    "eventname",
    "isinvalid",
    "isopen",
    "lastmodifiedby",
    "modificationdate",
)
DATE_FORMAT = "%m/%d/%Y %H:%M:%S"
DEFAULT_WINDOW_DAYS = 180
DEFAULT_WORK_WINDOW_DAYS = 7
CLOSE_DELAY = timedelta(days=1)  # cierre estimado cuando falta ModificationDate


def parse_date(value: str | None) -> datetime | None:
    """'10/07/2026 13:02:36' (UTC) -> datetime con zona UTC; None si vacío o inválido."""
    text = (value or "").strip()
    if not text:
        return None
    try:
        return datetime.strptime(text, DATE_FORMAT).replace(tzinfo=timezone.utc)
    except ValueError:
        return None


def iso_utc(moment: datetime | None) -> str | None:
    return moment.strftime("%Y-%m-%dT%H:%M:%SZ") if moment else None


def parse_bool(value: str | None) -> bool | None:
    text = (value or "").strip().lower()
    if text in ("true", "1", "t", "y"):
        return True
    if text in ("false", "0", "f", "n"):
        return False
    return None


def _clean(value: str | None) -> str:
    return (value or "").strip()


def adapt(rows: list[dict[str, str]], source: str, options: dict[str, Any] | None = None) -> AdapterResult:
    options = options or {}
    now: datetime = options.get("now") or datetime.now(timezone.utc)
    window_days = int(options.get("windowDays", DEFAULT_WINDOW_DAYS))
    work_days = int(options.get("workWindowDays", options.get("statsWindowDays", DEFAULT_WORK_WINDOW_DAYS)))
    cutoff = now - timedelta(days=window_days)
    work_cutoff = now - timedelta(days=work_days)
    weights = options.get("plannerWeights") or {}
    planner_tasks = options.get("plannerTasks")
    if planner_tasks is not None and not weights:
        raise AdapterError("falta options.plannerWeights en config.json para ponderar las tareas de Planner")

    assignment = None
    if options.get("assignment") is not None:
        try:
            assignment = normalize_config(options["assignment"])
        except AssignmentConfigError as exc:
            raise AdapterError(f"configuración de asignación inválida en config.json: {exc}") from None
    roster = {v["email"] for v in assignment["validators"]} if assignment else set()

    planner = planner_work(planner_tasks or [], weights, work_cutoff) if planner_tasks is not None else {}
    # Personas de interés: validadores + personas con carga de Planner.
    people = roster | {p["email"] for p in planner.values() if p.get("email")}

    result = AdapterResult()
    flights: dict[str, dict[str, Any]] = {}
    done: dict[str, dict[str, int]] = {}
    bad_flag = no_flight = no_date = 0
    seen_events: set[str] = set()
    duplicate_events = 0

    for raw in rows:
        row = {k.lower(): v for k, v in raw.items()}
        is_open = parse_bool(row.get("isopen"))
        if is_open is None:
            bad_flag += 1
            continue

        if not is_open:
            who = _clean(row.get("lastmodifiedby")).lower()
            modified = parse_date(row.get("modificationdate"))
            if modified is None:
                # La API deja vacía ModificationDate en la mayoría de los cierres: se estima
                # como la fecha del evento + 1 día.
                event_at = parse_date(row.get("eventdate")) or parse_date(row.get("takeoffdate"))
                modified = event_at + CLOSE_DELAY if event_at else None
            if "@" in who and who in people and modified is not None and modified >= work_cutoff:
                entry = done.setdefault(who, {"managed": 0, "invalidated": 0})
                entry["managed"] += 1
                if parse_bool(row.get("isinvalid")):
                    entry["invalidated"] += 1
            continue

        event_id = _clean(row.get("eventid"))
        if event_id in seen_events:
            duplicate_events += 1
            continue
        seen_events.add(event_id)
        flight_id = _clean(row.get("flightid"))
        if not flight_id:
            no_flight += 1
            continue
        when = parse_date(row.get("eventdate")) or parse_date(row.get("takeoffdate"))
        if when is None:
            no_date += 1

        flight = flights.get(flight_id)
        if flight is None:
            flight = flights[flight_id] = {
                "registration": _clean(row.get("registration")).upper(),
                "origin": _clean(row.get("originicao")).upper(),
                "destination": _clean(row.get("destinationicao")).upper(),
                "takeoffAt": iso_utc(parse_date(row.get("takeoffdate"))),
                "events": [],
            }
        flight["events"].append({
            "name": _clean(row.get("eventname")) or "(sin nombre)",
            "at": iso_utc(when),
            "inWindow": when is not None and when >= cutoff,
        })

    # Por vuelo se envía un resumen (no el detalle de cada evento): el payload debe
    # ser liviano para que la Function quepa en el límite de CPU del plan gratuito.
    # Evento abierto = isopen y fecha dentro de la ventana (openEvents, la carga del
    # vuelo). Los abiertos más antiguos se cuentan aparte (olderOpenEvents): no son
    # carga ni se reparten; un vuelo que solo tiene esos es un rezagado.
    for flight_id in sorted(flights):
        flight = flights[flight_id]
        current = [e for e in flight["events"] if e["inWindow"]]
        older = [e for e in flight["events"] if not e["inWindow"]]
        shown = current or older  # tipos y fechas de los eventos que cuentan
        dates = sorted(e["at"] for e in shown if e["at"])
        route = f"{flight['origin'] or '?'}–{flight['destination'] or '?'}"
        result.tasks.append(
            make_task(
                source=source,
                source_id=flight_id,
                title=f"{flight['registration'] or '(sin matrícula)'} {route}",
                assignees=[],  # el dueño lo decide la asignación (push_source.py)
                labels=sorted({e["name"] for e in shown}),
                status="pending",
                priority=None,
                created_at=dates[0] if dates else None,
                closed_at=None,
                extra={
                    "registration": flight["registration"],
                    "origin": flight["origin"],
                    "destination": flight["destination"],
                    "takeoffAt": flight["takeoffAt"],
                    "openEvents": len(current),
                    "olderOpenEvents": len(older),
                    "lastEventAt": dates[-1] if dates else None,
                },
            )
        )

    def summary_warning(count: int, code: str, message: str) -> None:
        if count:
            result.warnings.append(make_warning(source, None, code, f"{count} {message}"))

    summary_warning(bad_flag, "invalid_flag", "filas con isopen no reconocible; se omiten")
    summary_warning(no_flight, "missing_flight", "eventos abiertos sin flightid; se omiten")
    summary_warning(no_date, "invalid_date", "eventos abiertos sin fecha válida; quedan fuera de la ventana")
    summary_warning(duplicate_events, "duplicate_event", "eventos abiertos repetidos; se conserva el primero")

    # Carga de trabajo por persona (sin los vuelos pendientes, que dependen de la asignación).
    by_person: dict[str, dict[str, Any]] = {}
    for key, p in planner.items():
        by_person[key] = {"name": p["name"], "email": p["email"], "saraDone": 0, "saraInvalidated": 0,
                          "planner": {"pending": p["pending"], "done": p["done"], "byLabel": p["byLabel"]}}
    for email in sorted(people):
        entry = by_person.setdefault(email, {"name": None, "email": email, "saraDone": 0, "saraInvalidated": 0,
                                             "planner": {"pending": 0, "done": 0, "byLabel": {}}})
        entry["saraDone"] = done.get(email, {}).get("managed", 0)
        entry["saraInvalidated"] = done.get(email, {}).get("invalidated", 0)

    result.source_data = {
        "window": {"days": window_days, "from": iso_utc(cutoff)},
        "workload": {
            "windowDays": work_days,
            "from": iso_utc(work_cutoff),
            "to": iso_utc(now),
            "basis": "modificationdate",
            "weights": dict(sorted(weights.items(), key=lambda kv: (kv[1], kv[0]))),
            "byPerson": {k: by_person[k] for k in sorted(by_person)},
        },
    }
    team = options.get("team")
    if team is not None:
        if not isinstance(team, list) or not all(isinstance(e, str) and "@" in e for e in team):
            raise AdapterError("options.team debe ser una lista de correos")
        # Personas que muestra el dashboard (en este orden de configuración).
        result.source_data["team"] = list(dict.fromkeys(e.strip().lower() for e in team))
    if assignment is not None:
        result.source_data["assignment"] = assignment
    return result
