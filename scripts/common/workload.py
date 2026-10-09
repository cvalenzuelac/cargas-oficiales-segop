"""Carga de trabajo "justa" por persona, en eventos equivalentes.

    carga = eventos de Sara abiertos en sus vuelos asignados          (pendiente)
          + eventos de Sara que cerró en la ventana de trabajo         (hecho)
          + tareas de Planner abiertas, ponderadas por etiqueta        (pendiente)
          + tareas de Planner cerradas en la ventana, ponderadas       (hecho)

Ventana de trabajo: los últimos `workWindowDays` días (7). El reparto de vuelos busca
igualar esta carga, así quien trabaja más rápido no recibe más trabajo.

Pesos de Planner (config.json -> sources.sara.options.plannerWeights), p. ej.:
    Logged for Statistics (UR 1-10) = 5, Assessment (UR 20-50) = 15,
    FULL INVESTIGATION (UR 500-2500)) = 45
- Solo cuentan las etiquetas con peso; si una tarea tiene varias, se usa la de mayor peso.
- Si una tarea tiene varios responsables, el peso se divide entre ellos.
"""

from __future__ import annotations

from datetime import datetime
from typing import Any

from common.normalize import normalize_name


def _parse_iso(value: str | None) -> datetime | None:
    if not value:
        return None
    try:
        return datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None


def task_weight(labels: list[str], weights: dict[str, float]) -> tuple[str, float] | None:
    """(etiqueta, peso) de mayor peso entre las etiquetas de la tarea; None si ninguna pesa.
    Las etiquetas se comparan normalizadas (sin tildes, minúsculas, espacios colapsados)."""
    by_norm = {normalize_name(k): (k, w) for k, w in weights.items()}
    best = None
    for label in labels or []:
        hit = by_norm.get(normalize_name(label))
        if hit and (best is None or hit[1] > best[1]):
            best = hit
    return best


def planner_work(
    tasks: list[dict[str, Any]], weights: dict[str, float], since: datetime
) -> dict[str, dict[str, Any]]:
    """Carga de Planner por persona (key): {"name", "email", "pending", "done", "byLabel"}.

    pending = tareas abiertas; done = tareas cerradas desde `since` (closedAt).
    byLabel = {etiqueta: {"pending", "done", "tasks"}} con los pesos ya divididos."""
    out: dict[str, dict[str, Any]] = {}
    for task in tasks:
        hit = task_weight(task.get("labels") or [], weights)
        people = task.get("assignees") or []
        if hit is None or not people:
            continue
        label, weight = hit
        if task.get("status") != "completed" and not task.get("closedAt"):
            kind = "pending"
        else:
            closed = _parse_iso(task.get("closedAt"))
            if closed is None or closed < since:
                continue
            kind = "done"
        share = weight / len(people)
        for person in people:
            entry = out.setdefault(person["key"], {
                "name": person.get("name"), "email": person.get("email"), "pending": 0.0, "done": 0.0, "byLabel": {},
            })
            entry[kind] += share
            per_label = entry["byLabel"].setdefault(label, {"pending": 0.0, "done": 0.0, "tasks": 0})
            per_label[kind] += share
            per_label["tasks"] += 1
    return {key: _rounded(v) for key, v in sorted(out.items())}


def _rounded(entry: dict[str, Any]) -> dict[str, Any]:
    r = lambda x: round(x, 4)  # noqa: E731 - evita ruido de coma flotante en el JSON
    return {
        **entry,
        "pending": r(entry["pending"]),
        "done": r(entry["done"]),
        "byLabel": {k: {**v, "pending": r(v["pending"]), "done": r(v["done"])} for k, v in sorted(entry["byLabel"].items())},
    }


def baseline_from_workload(workload: dict[str, Any] | None) -> dict[str, float]:
    """Carga previa (sin los vuelos pendientes de Sara) por correo, para la asignación."""
    out: dict[str, float] = {}
    for person in ((workload or {}).get("byPerson") or {}).values():
        email = person.get("email")
        if not email:
            continue
        planner = person.get("planner") or {}
        out[email] = round(
            (person.get("saraDone") or 0) + (planner.get("pending") or 0) + (planner.get("done") or 0), 4
        )
    return out
