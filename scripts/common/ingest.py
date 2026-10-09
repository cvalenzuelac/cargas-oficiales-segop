"""Lógica de los endpoints del servidor local; gemela de functions/_lib/service.js.

Mismo protocolo y mismo esquema de almacenamiento que KV (ver functions/_lib/storage.js):
    GET  /api/ingest/:source/state                 dueños actuales
    POST /api/ingest/:source/parts?batch=B&index=N { tasks }  valida y guarda la parte N
    POST /api/ingest/:source                       { batch, parts, ... }  publica el lote
"""

from __future__ import annotations

import hashlib
import hmac
import json
from datetime import datetime, timezone
from typing import Any, Callable, Protocol

from common.schema import (
    DEFAULT_MAX_INVALID_RATIO,
    MAX_PARTS,
    is_valid_batch,
    is_valid_source_name,
    validate_commit,
    validate_payload,
)

MAX_BODY_BYTES = 5 * 1024 * 1024
MAX_PART_BYTES = 1024 * 1024
MAX_REPORTED_ITEMS = 100


class Store(Protocol):
    def get_index_text(self) -> str | None: ...
    def put_index(self, index: dict[str, Any]) -> None: ...
    def get_meta_text(self, source: str) -> str | None: ...
    def put_meta(self, source: str, meta: dict[str, Any]) -> None: ...
    def put_part(self, source: str, batch: str, index: int, text: str) -> None: ...
    def get_part_text(self, source: str, batch: str, index: int) -> str | None: ...
    def delete_part(self, source: str, batch: str, index: int) -> None: ...


def now_iso() -> str:
    """Instante actual en UTC, mismo formato que Date.prototype.toISOString()."""
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def ingest_key_var(source: str) -> str:
    return "INGEST_KEY_" + source.upper().replace("-", "_")


def expected_key(env: dict[str, str], source: str) -> str | None:
    return env.get(ingest_key_var(source)) or env.get("INGEST_KEY") or None


def keys_match(provided: str | None, expected: str) -> bool:
    return provided is not None and hmac.compare_digest(provided.encode("utf-8"), expected.encode("utf-8"))


def make_etag(text: str) -> str:
    return '"' + hashlib.sha256(text.encode("utf-8")).hexdigest() + '"'


def serialize(data: Any) -> str:
    return json.dumps(data, ensure_ascii=False, separators=(",", ":"))


def max_invalid_ratio(env: dict[str, str]) -> float:
    try:
        value = float(env.get("MAX_INVALID_RATIO", ""))
    except ValueError:
        return DEFAULT_MAX_INVALID_RATIO
    return value if 0 <= value <= 1 else DEFAULT_MAX_INVALID_RATIO


Reply = tuple[int, dict[str, Any], "str | None"]  # (status, cuerpo, header Allow)


def handle_ingest_route(
    store: Store,
    path: list[str],
    method: str,
    query: dict[str, str],
    api_key: str | None,
    body: bytes,
    env: dict[str, str],
) -> Reply:
    """Enruta /api/ingest/*. `path` = segmentos tras /api/ingest/."""
    source = path[0] if path else None
    action = path[1] if len(path) > 1 else None
    if not source or len(path) > 2 or action not in (None, "parts", "state"):
        return 404, {"error": "ruta no encontrada"}, None
    allowed = "GET" if action == "state" else "POST"
    if method != allowed:
        return 405, {"error": "método no permitido"}, allowed
    if not is_valid_source_name(source):
        return 400, {"error": "nombre de fuente inválido"}, None

    expected = expected_key(env, source)
    if not expected:
        return 500, {"error": "INGEST_KEY no configurada en el servidor"}, None
    if not keys_match(api_key, expected):
        return 401, {"error": "x-api-key inválida o ausente"}, None

    if action == "state":
        return (*_state(store, source), None)

    limit = MAX_PART_BYTES if action == "parts" else MAX_BODY_BYTES
    if len(body) > limit:
        return 413, {"error": f"el cuerpo supera {limit} bytes"}, None
    try:
        text = body.decode("utf-8-sig")
        payload = json.loads(text)
    except (UnicodeDecodeError, json.JSONDecodeError):
        return 400, {"error": "el cuerpo no es JSON válido"}, None
    if action == "parts":
        return (*_part(store, source, query, text, payload, env), None)
    return (*_commit(store, source, payload, env), None)


def _state(store: Store, source: str) -> tuple[int, dict[str, Any]]:
    meta_text = store.get_meta_text(source)
    meta = json.loads(meta_text) if meta_text else {}
    return 200, {"updatedAt": meta.get("updatedAt"), "owners": (meta.get("assignment") or {}).get("owners") or {}}


def _part(store: Store, source: str, query: dict[str, str], text: str, payload: Any, env: dict[str, str]):
    batch = query.get("batch")
    raw_index = query.get("index", "")
    if not is_valid_batch(batch):
        return 400, {"error": '"batch" debe tener 8 a 64 letras minúsculas o números'}
    if not raw_index.isdigit() or str(int(raw_index)) != raw_index or int(raw_index) >= MAX_PARTS:
        return 400, {"error": f'"index" debe ser un entero entre 0 y {MAX_PARTS - 1}'}
    index = int(raw_index)
    check = validate_payload(payload, source, max_invalid_ratio(env))
    if check["error"]:
        return 400, {"error": check["error"]}
    received = len(check["tasks"]) + len(check["invalid"])
    invalid = check["invalid"][:MAX_REPORTED_ITEMS]
    if check["rejected"]:
        return 422, {
            "error": "demasiadas tareas inválidas en la parte; no se guardó",
            "received": received,
            "invalidCount": len(check["invalid"]),
            "invalid": invalid,
        }
    store.put_part(source, batch, index, text)
    return 200, {
        "ok": True,
        "batch": batch,
        "index": index,
        "length": len(text),
        "received": received,
        "accepted": len(check["tasks"]),
        "invalidIndexes": [item["index"] for item in check["invalid"]],
        "invalid": invalid,
    }


def _commit(store: Store, source: str, payload: Any, env: dict[str, str]):
    check = validate_commit(payload, max_invalid_ratio(env))
    if check["error"]:
        return 400, {"error": check["error"]}
    if check["rejected"]:
        return 422, {
            "error": "demasiadas tareas inválidas; no se publicó",
            "received": check["received"],
            "invalidCount": check["invalidCount"],
        }
    previous_text = store.get_meta_text(source)
    previous = json.loads(previous_text) if previous_text else None

    updated_at = now_iso()
    warnings = payload.get("warnings") or []
    meta = {
        "source": source,
        "updatedAt": updated_at,
        "generatedAt": payload.get("generatedAt"),
        "batch": payload["batch"],
        "parts": [{"index": p["index"], "length": p["length"], "invalidIndexes": p["invalidIndexes"]}
                  for p in payload["parts"]],
        "received": check["received"],
        "warnings": warnings,
        "sourceData": payload.get("sourceData"),
        "assignment": payload.get("assignment"),
    }
    accepted = check["received"] - check["invalidCount"]
    store.put_meta(source, meta)
    index_text = store.get_index_text()
    index = json.loads(index_text) if index_text else {"sources": {}}
    # batch: el ETag de /api/data sale del índice; cada publicación debe cambiarlo.
    index["sources"][source] = {
        "updatedAt": updated_at, "count": accepted, "warnings": len(warnings), "batch": payload["batch"],
    }
    index["datasetUpdatedAt"] = updated_at
    store.put_index(index)

    deleted = 0
    if previous and previous.get("batch") and previous["batch"] != payload["batch"]:
        for p in previous.get("parts") or []:
            store.delete_part(source, previous["batch"], p["index"])
            deleted += 1

    return 200, {
        "ok": True,
        "source": source,
        "received": check["received"],
        "accepted": accepted,
        "invalidCount": check["invalidCount"],
        "warningCount": len(warnings),
        "updatedAt": updated_at,
        "kvWrites": 2,
        "partsDeleted": deleted,
    }


def data_response(store: Store) -> tuple[str, Callable[[], tuple[str, bool]]]:
    """(etag, build): build() -> (texto, consistente). Ver dataResponse en service.js."""
    index_text = store.get_index_text() or '{"sources":{}}'
    etag = make_etag(index_text)

    def build() -> tuple[str, bool]:
        index = json.loads(index_text)
        sources = index.get("sources") or {}
        consistent = True
        bodies = []
        for name, info in sources.items():
            meta_text = store.get_meta_text(name)
            meta = json.loads(meta_text) if meta_text else None
            parts = (meta or {}).get("parts") or []
            chunks = [store.get_part_text(name, meta["batch"], p["index"]) for p in parts]
            current = (
                meta is not None
                and meta.get("updatedAt") == info.get("updatedAt")
                and all(c is not None and len(c) == p["length"] for c, p in zip(chunks, parts))
            )
            if not current:
                consistent = False
            chunk_list = ",".join(c if c is not None else "null" for c in chunks)
            bodies.append(f'{json.dumps(name)}:{{"meta":{meta_text or "null"},"chunks":[{chunk_list}]}}')
        text = (
            f'{{"generatedAt":{json.dumps(index.get("datasetUpdatedAt"))},'
            f'"sources":{serialize(sources)},"parts":{{{",".join(bodies)}}}}}'
        )
        return text, consistent

    return etag, build


def etag_matches(if_none_match: str | None, etag: str) -> bool:
    if not if_none_match:
        return False
    if if_none_match.strip() == "*":
        return True
    candidates = [tag.strip().removeprefix("W/") for tag in if_none_match.split(",")]
    return etag in candidates


def health(store: Store) -> dict[str, Any]:
    index_text = store.get_index_text()
    index = json.loads(index_text) if index_text else None
    if not index or not index.get("sources"):
        return {"status": "empty", "datasetUpdatedAt": None, "sources": {}}
    return {
        "status": "ok",
        "datasetUpdatedAt": index.get("datasetUpdatedAt"),
        "sources": index["sources"],
    }
