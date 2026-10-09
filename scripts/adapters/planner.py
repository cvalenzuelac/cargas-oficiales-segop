"""Adaptador de la fuente `planner` (CSV exportado por Power Automate desde Planner)."""

from __future__ import annotations

import json
from typing import Any, Callable

from adapters import AdapterResult, dedupe_people, make_person, make_task, make_warning
from common.normalize import normalize_name, split_labels, split_list, to_iso_bogota

REQUIRED_COLUMNS = (
    "Id",
    "Titulo",
    "Responsables",
    "Correos",
    "Etiquetas",
    "Estado",
    "Prioridad",
    "FechaCreacion",
    "FechaCierre",
)

# Claves en forma normalizada (sin tildes, minúsculas) para tolerar variaciones menores.
STATUS_MAP = {
    "no iniciada": "not_started",
    "en curso": "in_progress",
    "completada": "completed",
}
PRIORITY_MAP = {
    "urgente": "urgent",
    "importante": "important",
    "media": "medium",
    "baja": "low",
}

Warn = Callable[[str, str], None]


def adapt(rows: list[dict[str, str]], source: str, options: dict[str, Any] | None = None) -> AdapterResult:
    result = AdapterResult()
    seen_ids: set[str] = set()

    for line, row in enumerate(rows, start=2):  # la fila 1 es el encabezado
        source_id = (row.get("Id") or "").strip()
        if not source_id:
            result.warnings.append(make_warning(source, None, "missing_id", f"fila {line} sin Id; se omite"))
            continue
        if source_id in seen_ids:
            result.warnings.append(
                make_warning(source, source_id, "duplicate_id", f"fila {line}: Id repetido; se conserva la primera")
            )
            continue
        seen_ids.add(source_id)

        def warn(code: str, message: str, _id: str = source_id) -> None:
            result.warnings.append(make_warning(source, _id, code, message))

        result.tasks.append(
            make_task(
                source=source,
                source_id=source_id,
                title=(row.get("Titulo") or "").strip(),
                assignees=_assignees(row.get("Responsables"), row.get("Correos"), warn),
                labels=split_labels(row.get("Etiquetas")),
                status=_status(row.get("Estado"), warn),
                priority=_priority(row.get("Prioridad"), warn),
                created_at=_date(row.get("FechaCreacion"), "FechaCreacion", warn),
                closed_at=_date(row.get("FechaCierre"), "FechaCierre", warn),
            )
        )
    return result


def display_name(raw: str) -> str:
    """El flujo de Power Automate puede escribir el objeto del usuario en vez del texto:
    '{"displayName":"Ana Pérez"}' -> 'Ana Pérez'. El texto plano se deja igual."""
    text = raw.strip()
    if text.startswith("{") and text.endswith("}"):
        try:
            value = json.loads(text)
        except json.JSONDecodeError:
            return text
        if isinstance(value, dict):
            for key in ("displayName", "name"):
                if isinstance(value.get(key), str):
                    return value[key].strip()
    return text


def _assignees(names_field: str | None, emails_field: str | None, warn: Warn) -> list[dict[str, Any]]:
    names = [display_name(n) for n in split_list(names_field)]
    emails = split_list(emails_field)

    if len(names) != len(emails):
        warn(
            "assignee_email_mismatch",
            f"{len(names)} responsables y {len(emails)} correos; se usa el nombre normalizado como key",
        )
        return dedupe_people([make_person(name, None) for name in names if name])

    people = []
    for name, email in zip(names, emails):
        if not name and not email:
            continue
        if not email:
            warn("assignee_email_missing", f"responsable {name!r} sin correo; se usa el nombre normalizado como key")
        people.append(make_person(name or email, email))
    return dedupe_people(people)


def _status(value: str | None, warn: Warn) -> str:
    raw = (value or "").strip()
    mapped = STATUS_MAP.get(normalize_name(raw))
    if mapped:
        return mapped
    warn("unknown_status", f"estado desconocido: {raw!r}; se conserva tal cual")
    return raw or "unknown"


def _priority(value: str | None, warn: Warn) -> str | None:
    raw = (value or "").strip()
    mapped = PRIORITY_MAP.get(normalize_name(raw))
    if mapped:
        return mapped
    warn("unknown_priority", f"prioridad desconocida: {raw!r}; se usa null")
    return None


def _date(value: str | None, column: str, warn: Warn) -> str | None:
    try:
        return to_iso_bogota(value)
    except ValueError:
        warn("invalid_date", f"{column} con formato inválido: {value!r}; se usa null")
        return None
