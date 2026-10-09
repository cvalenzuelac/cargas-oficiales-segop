"""Registro de adaptadores de fuentes.

Un adaptador es un módulo de este paquete que expone:

    REQUIRED_COLUMNS: tuple[str, ...]
        Columnas que deben existir en el CSV. Si falta alguna, la carga se aborta.

    def adapt(rows: list[dict[str, str]], source: str, options: dict | None = None) -> AdapterResult
        Convierte las filas del CSV en tareas del modelo común (ver README) y
        devuelve también los warnings por tarea. `options` trae la sección
        "options" de la fuente en config.json, la configuración de asignación
        ("assignment", si la hay) y "now" (datetime UTC de la ejecución).
        Opcionalmente llena AdapterResult.source_data, que viaja como
        "sourceData" en el payload (p. ej. la configuración de asignación).

Para registrar una fuente nueva: copiar template.py, implementarlo y agregar
una línea en REGISTRY. Las Functions de Cloudflare no se tocan.
"""

from __future__ import annotations

import importlib
from dataclasses import dataclass, field
from types import ModuleType
from typing import Any

from common.normalize import normalize_email, normalize_name

# nombre del adaptador -> módulo dentro de este paquete
REGISTRY: dict[str, str] = {
    "planner": "adapters.planner",
    "sara": "adapters.sara",
}


class AdapterError(Exception):
    """Error que impide procesar la fuente completa (p. ej. faltan columnas)."""


@dataclass
class AdapterResult:
    tasks: list[dict[str, Any]] = field(default_factory=list)
    warnings: list[dict[str, Any]] = field(default_factory=list)
    source_data: dict[str, Any] = field(default_factory=dict)


def make_warning(source: str, source_id: str | None, code: str, message: str) -> dict[str, Any]:
    """Warning con forma estable; la Function los guarda tal cual."""
    return {"source": source, "sourceId": source_id, "code": code, "message": message}


def make_person(name: str, email: str | None) -> dict[str, Any]:
    """PersonRef: key = correo en minúsculas o, si no hay correo, nombre normalizado."""
    display = " ".join((name or "").split())
    email_norm = normalize_email(email)
    return {"key": email_norm or normalize_name(display), "name": display, "email": email_norm}


def dedupe_people(people: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Quita responsables repetidos (misma key) conservando el primero."""
    unique: dict[str, dict[str, Any]] = {}
    for person in people:
        if person["key"]:
            unique.setdefault(person["key"], person)
    return list(unique.values())


def make_task(
    *,
    source: str,
    source_id: str,
    title: str,
    assignees: list[dict[str, Any]],
    labels: list[str],
    status: str,
    priority: str | None,
    created_at: str | None,
    closed_at: str | None,
    extra: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """Construye una Task del modelo común con el orden de campos del contrato."""
    return {
        "uid": f"{source}:{source_id}",
        "source": source,
        "sourceId": source_id,
        "title": title,
        "assignees": assignees,
        "labels": labels,
        "status": status,
        "priority": priority,
        "createdAt": created_at,
        "closedAt": closed_at,
        "extra": extra or {},
    }


def get_adapter(name: str) -> ModuleType:
    try:
        module_name = REGISTRY[name]
    except KeyError:
        known = ", ".join(sorted(REGISTRY)) or "(ninguno)"
        raise AdapterError(f"adaptador desconocido: {name!r}. Registrados: {known}") from None
    return importlib.import_module(module_name)


def check_columns(columns: list[str], required: tuple[str, ...]) -> None:
    """Las columnas se comparan sin distinguir mayúsculas (flightId == flightid)."""
    present = {c.lower() for c in columns}
    missing = [col for col in required if col.lower() not in present]
    if missing:
        raise AdapterError(f"faltan columnas en el CSV: {', '.join(missing)}")


def run_adapter(
    name: str,
    columns: list[str],
    rows: list[dict[str, str]],
    source: str,
    options: dict[str, Any] | None = None,
) -> AdapterResult:
    """Valida columnas y ejecuta el adaptador registrado como `name`."""
    adapter = get_adapter(name)
    check_columns(columns, adapter.REQUIRED_COLUMNS)
    return adapter.adapt(rows, source, options or {})
