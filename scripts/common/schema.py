"""Validación del payload de ingesta y de cada Task del modelo común.

Gemelo de `functions/_lib/schema.js`. Python lo usa antes de enviar (y en
dev_server.py); la Function aplica las mismas reglas. Los casos compartidos
están en fixtures/schema_cases.json.

Cada error es {"field": str, "message": str}.
"""

from __future__ import annotations

import re
from typing import Any

DEFAULT_MAX_INVALID_RATIO = 0.1
PRIORITIES = ("urgent", "important", "medium", "low")
MAX_PARTS = 200
SOURCE_NAME_RE = re.compile(r"^[a-z0-9][a-z0-9_-]{0,39}$")
BATCH_RE = re.compile(r"^[a-z0-9]{8,64}$")
ISO_DATE_RE = re.compile(r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$")


def is_valid_source_name(name: Any) -> bool:
    return isinstance(name, str) and bool(SOURCE_NAME_RE.match(name))


def is_valid_batch(batch: Any) -> bool:
    return isinstance(batch, str) and bool(BATCH_RE.match(batch))


def _is_int(value: Any) -> bool:
    return isinstance(value, int) and not isinstance(value, bool)


def validate_commit(body: Any, max_invalid_ratio: float = DEFAULT_MAX_INVALID_RATIO) -> dict[str, Any]:
    """Gemelo de validateCommit (schema.js). Devuelve {"error", "rejected", "received", "invalidCount"}."""

    def fail(error: str) -> dict[str, Any]:
        return {"error": error, "rejected": False, "received": 0, "invalidCount": 0}

    if not _is_obj(body):
        return fail("el cuerpo debe ser un objeto JSON")
    if not is_valid_batch(body.get("batch")):
        return fail('"batch" debe tener 8 a 64 letras minúsculas o números')
    parts = body.get("parts")
    if not isinstance(parts, list) or not parts or len(parts) > MAX_PARTS:
        return fail(f'"parts" debe ser una lista de 1 a {MAX_PARTS} partes')
    received = invalid_count = 0
    for i, p in enumerate(parts):
        if not _is_obj(p) or not _is_int(p.get("index")) or p.get("index") != i:
            return fail(f"parts[{i}].index debe ser {i}")
        if not _is_int(p.get("length")) or p["length"] < 2:
            return fail(f"parts[{i}].length debe ser un entero")
        if not _is_int(p.get("received")) or p["received"] < 0:
            return fail(f"parts[{i}].received debe ser un entero >= 0")
        indexes = p.get("invalidIndexes")
        if not isinstance(indexes, list) or not all(_is_int(x) and 0 <= x < p["received"] for x in indexes):
            return fail(f"parts[{i}].invalidIndexes debe ser una lista de posiciones válidas")
        received += p["received"]
        invalid_count += len(indexes)
    warnings = body.get("warnings")
    if warnings is not None and (not isinstance(warnings, list) or not all(_is_obj(w) for w in warnings)):
        return fail('"warnings" debe ser una lista de objetos')
    if body.get("generatedAt") is not None and not _is_str(body["generatedAt"]):
        return fail('"generatedAt" debe ser texto')
    if body.get("sourceData") is not None and not _is_obj(body["sourceData"]):
        return fail('"sourceData" debe ser un objeto')
    assignment = body.get("assignment")
    if assignment is not None:
        if not _is_obj(assignment) or not _is_obj(assignment.get("owners")) or not _is_obj(assignment.get("summary")):
            return fail('"assignment" debe ser { owners, summary }')
        for fid, o in assignment["owners"].items():
            if not _is_obj(o) or not _is_str(o.get("owner")) or "@" not in o["owner"] or not _is_str(o.get("since")):
                return fail(f'assignment.owners["{fid}"] debe ser {{ owner: correo, since: fecha }}')
    rejected = received > 0 and invalid_count / received > max_invalid_ratio
    return {"error": None, "rejected": rejected, "received": received, "invalidCount": invalid_count}


def _is_str(value: Any) -> bool:
    return isinstance(value, str)


def _is_obj(value: Any) -> bool:
    return isinstance(value, dict)


def validate_task(task: Any, source: str) -> list[dict[str, str]]:
    errors: list[dict[str, str]] = []

    def err(field: str, message: str) -> None:
        errors.append({"field": field, "message": message})

    if not _is_obj(task):
        err("task", "debe ser un objeto")
        return errors

    source_id = task.get("sourceId")
    source_id_ok = _is_str(source_id) and source_id != ""
    if not source_id_ok:
        err("sourceId", "debe ser texto no vacío")
    if task.get("source") != source:
        err("source", f'debe ser "{source}"')
    if source_id_ok and task.get("uid") != f"{source}:{source_id}":
        err("uid", f'debe ser "{source}:{source_id}"')
    if not _is_str(task.get("title")):
        err("title", "debe ser texto")

    assignees = task.get("assignees")
    if not isinstance(assignees, list):
        err("assignees", "debe ser una lista")
    else:
        for i, ref in enumerate(assignees):
            prefix = f"assignees[{i}]"
            if not _is_obj(ref):
                err(prefix, "debe ser un objeto")
                continue
            key, name, email = ref.get("key"), ref.get("name"), ref.get("email")
            if not _is_str(name):
                err(f"{prefix}.name", "debe ser texto")
            if email is not None and not (_is_str(email) and "@" in email):
                err(f"{prefix}.email", "debe ser un correo o null")
            elif not (_is_str(key) and key != ""):
                err(f"{prefix}.key", "debe ser texto no vacío")
            elif email is not None and key != email.lower():
                err(f"{prefix}.key", "debe ser el correo en minúsculas")

    labels = task.get("labels")
    if not isinstance(labels, list):
        err("labels", "debe ser una lista")
    else:
        for i, label in enumerate(labels):
            if not _is_str(label):
                err(f"labels[{i}]", "debe ser texto")

    status = task.get("status")
    if not (_is_str(status) and status != ""):
        err("status", "debe ser texto no vacío")
    priority = task.get("priority")
    if priority is not None and priority not in PRIORITIES:
        err("priority", f"debe ser null o uno de: {', '.join(PRIORITIES)}")
    for field in ("createdAt", "closedAt"):
        value = task.get(field)
        if value is not None and not (_is_str(value) and ISO_DATE_RE.match(value)):
            err(field, "debe ser null o fecha ISO 8601 con zona horaria")
    if not _is_obj(task.get("extra")):
        err("extra", "debe ser un objeto")
    return errors


def validate_payload(body: Any, source: str, max_invalid_ratio: float = DEFAULT_MAX_INVALID_RATIO) -> dict[str, Any]:
    """Valida el cuerpo de POST /api/ingest/:source.

    Devuelve {"error", "rejected", "tasks", "invalid", "warnings", "generatedAt", "sourceData"}:
    - error: texto si la estructura general es inválida (HTTP 400), si no None.
    - rejected: True si las tareas inválidas superan max_invalid_ratio (HTTP 422).
    - tasks: tareas válidas; invalid: [{"index", "uid", "errors"}].
    """
    result: dict[str, Any] = {
        "error": None, "rejected": False, "tasks": [], "invalid": [], "warnings": [], "generatedAt": None,
        "sourceData": None,
    }
    if not _is_obj(body):
        result["error"] = "el cuerpo debe ser un objeto JSON"
        return result
    tasks = body.get("tasks")
    if not isinstance(tasks, list):
        result["error"] = '"tasks" debe ser una lista'
        return result
    warnings = body.get("warnings")
    if warnings is None:
        warnings = []
    if not isinstance(warnings, list) or not all(_is_obj(w) for w in warnings):
        result["error"] = '"warnings" debe ser una lista de objetos'
        return result
    generated_at = body.get("generatedAt")
    if generated_at is not None and not _is_str(generated_at):
        result["error"] = '"generatedAt" debe ser texto'
        return result
    source_data = body.get("sourceData")
    if source_data is not None and not _is_obj(source_data):
        result["error"] = '"sourceData" debe ser un objeto'
        return result

    seen: set[str] = set()
    for index, task in enumerate(tasks):
        errors = validate_task(task, source)
        uid = task.get("uid") if _is_obj(task) and _is_str(task.get("uid")) else None
        if not errors and uid in seen:
            errors = [{"field": "uid", "message": "repetido en el payload"}]
        if errors:
            result["invalid"].append({"index": index, "uid": uid, "errors": errors})
        else:
            seen.add(uid)
            result["tasks"].append(task)

    ratio = len(result["invalid"]) / len(tasks) if tasks else 0
    result["rejected"] = ratio > max_invalid_ratio
    result["warnings"] = warnings
    result["generatedAt"] = generated_at
    result["sourceData"] = source_data
    return result
