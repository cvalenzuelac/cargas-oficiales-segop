"""Plantilla para el adaptador de una fuente nueva.

Este módulo NO está registrado. Para crear una fuente nueva:

1. Copia este archivo como `adapters/<nombre>.py` (p. ej. `adapters/auditorias.py`).
2. Ajusta REQUIRED_COLUMNS y COLUMNS a los encabezados reales del CSV.
3. Completa STATUS_MAP / PRIORITY_MAP con los valores reales de la fuente
   (las claves van normalizadas: sin tildes, en minúsculas).
4. Revisa `_assignees`: si la fuente no trae correo, deja `email` en None.
   El navegador unificará a la persona con alguien de otra fuente cuando el
   nombre normalizado coincida sin ambigüedad.
5. Pon en `extra` los campos propios de la fuente que la UI pueda necesitar.
6. Registra el adaptador en `adapters/__init__.py` (REGISTRY).
7. Agrega la fuente en `config.json` y un CSV ficticio + tests en `fixtures/` y `tests/`.

Contrato de salida (lo valida la Function):

    Task {
      uid: "<source>:<sourceId>"     -> lo arma make_task
      source, sourceId: str
      title: str
      assignees: [PersonRef]         -> usa make_person / dedupe_people
      labels: [str]
      status: "not_started" | "in_progress" | "completed" | otro str no vacío
      priority: "urgent" | "important" | "medium" | "low" | None
      createdAt, closedAt: ISO 8601 con offset -05:00 o None (usa to_iso_bogota)
      extra: dict
    }

Los problemas por tarea se reportan como warnings (make_warning), no como
excepciones. Lanza AdapterError solo si la fuente completa es inutilizable.
"""

from __future__ import annotations

from typing import Any, Callable

from adapters import AdapterResult, dedupe_people, make_person, make_task, make_warning
from common.normalize import normalize_name, split_labels, split_list, to_iso_bogota

# TODO: nombres reales de las columnas del CSV de la fuente.
COLUMNS = {
    "id": "ID",
    "title": "Titulo",
    "assignee_names": "Responsable",
    "assignee_emails": None,  # None si la fuente no trae correos
    "labels": None,  # None si no hay etiquetas
    "status": "Estado",
    "priority": None,  # None si la fuente no maneja prioridad
    "created_at": "FechaCreacion",
    "closed_at": "FechaCierre",
}
REQUIRED_COLUMNS = tuple(col for col in COLUMNS.values() if col)

# TODO: valores reales de la fuente -> modelo común.
STATUS_MAP: dict[str, str] = {
    # "pendiente": "not_started",
    # "en proceso": "in_progress",
    # "cerrada": "completed",
}
PRIORITY_MAP: dict[str, str] = {
    # "alta": "urgent",
}

Warn = Callable[[str, str], None]


def adapt(rows: list[dict[str, str]], source: str, options: dict[str, Any] | None = None) -> AdapterResult:
    # options: sección "options" de la fuente en config.json + "now" (datetime UTC).
    result = AdapterResult()
    seen_ids: set[str] = set()

    for line, row in enumerate(rows, start=2):
        source_id = _get(row, "id").strip()
        if not source_id:
            result.warnings.append(make_warning(source, None, "missing_id", f"fila {line} sin Id; se omite"))
            continue
        if source_id in seen_ids:
            result.warnings.append(make_warning(source, source_id, "duplicate_id", f"fila {line}: Id repetido"))
            continue
        seen_ids.add(source_id)

        def warn(code: str, message: str, _id: str = source_id) -> None:
            result.warnings.append(make_warning(source, _id, code, message))

        result.tasks.append(
            make_task(
                source=source,
                source_id=source_id,
                title=_get(row, "title").strip(),
                assignees=_assignees(row, warn),
                labels=split_labels(_get(row, "labels")),
                status=_status(_get(row, "status"), warn),
                priority=_priority(_get(row, "priority"), warn),
                created_at=_date(_get(row, "created_at"), "created_at", warn),
                closed_at=_date(_get(row, "closed_at"), "closed_at", warn),
                extra={},  # TODO: campos propios de la fuente
            )
        )
    return result


def _get(row: dict[str, str], field: str) -> str:
    column = COLUMNS.get(field)
    return (row.get(column) or "") if column else ""


def _assignees(row: dict[str, str], warn: Warn) -> list[dict[str, Any]]:
    names = split_list(_get(row, "assignee_names"))
    if COLUMNS["assignee_emails"] is None:
        # Fuente sin correos: key = nombre normalizado; el navegador intentará unificar.
        return dedupe_people([make_person(name, None) for name in names if name])

    emails = split_list(_get(row, "assignee_emails"))
    if len(names) != len(emails):
        warn("assignee_email_mismatch", f"{len(names)} responsables y {len(emails)} correos")
        return dedupe_people([make_person(name, None) for name in names if name])
    people = []
    for name, email in zip(names, emails):
        if not name and not email:
            continue
        if not email:
            warn("assignee_email_missing", f"responsable {name!r} sin correo")
        people.append(make_person(name or email, email))
    return dedupe_people(people)


def _status(value: str, warn: Warn) -> str:
    raw = value.strip()
    mapped = STATUS_MAP.get(normalize_name(raw))
    if mapped:
        return mapped
    warn("unknown_status", f"estado desconocido: {raw!r}; se conserva tal cual")
    return raw or "unknown"


def _priority(value: str, warn: Warn) -> str | None:
    if COLUMNS["priority"] is None:
        return None
    raw = value.strip()
    mapped = PRIORITY_MAP.get(normalize_name(raw))
    if mapped:
        return mapped
    warn("unknown_priority", f"prioridad desconocida: {raw!r}; se usa null")
    return None


def _date(value: str, field: str, warn: Warn) -> str | None:
    # TODO: si la fuente usa otro formato de fecha, conviértelo aquí antes de to_iso_bogota.
    try:
        return to_iso_bogota(value)
    except ValueError:
        warn("invalid_date", f"{field} con formato inválido: {value!r}; se usa null")
        return None
