"""Lee el CSV de una fuente, lo normaliza con su adaptador y lo envía a /api/ingest/:source.

    python scripts/push_source.py planner            # envía si el CSV cambió
    python scripts/push_source.py --all              # todas las fuentes de config.json
    python scripts/push_source.py planner --dry-run  # muestra el payload sin enviarlo
    python scripts/push_source.py planner --force    # envía aunque el CSV no haya cambiado

Configuración:
- config.json (ver config.example.json), por fuente:
    csvPath                 archivo CSV local, o bien
    type "http" + url       CSV descargado de una API; apiKeyEnv = variable con la clave,
                            apiKeyParam = parámetro de la URL donde va (se oculta en logs)
    adapter, delimiter      adaptador registrado y delimitador
    repairColumn            columna que puede traer el delimitador sin comillas
    options                 opciones del adaptador (p. ej. windowDays)
    assignment              validadores y restricciones (fuentes con asignación)
- Variables de entorno, o un archivo de variables (--env-file, por defecto .env; las
  variables ya definidas en el entorno tienen prioridad):
    INGEST_URL   p. ej. https://<proyecto>.pages.dev  o  http://127.0.0.1:8787
    INGEST_KEY   clave compartida (o INGEST_KEY_<FUENTE> para una clave por fuente)
  Convención: .env para local y .env.production para producción
  (python scripts/push_source.py --all --env-file .env.production).

Códigos de salida: 0 = enviado o sin cambios, 1 = fallo de envío, 2 = error de configuración o datos.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import logging
import logging.handlers
import os
import random
import secrets
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any

sys.path.insert(0, str(Path(__file__).resolve().parent))

from adapters import AdapterError, run_adapter  # noqa: E402
from common.assignment import assign_flights, normalize_config  # noqa: E402
from common.workload import baseline_from_workload  # noqa: E402
from common.csv_source import parse_rows  # noqa: E402
from common.env import load_env_file  # noqa: E402
from common.ingest import ingest_key_var  # noqa: E402
from common.schema import is_valid_source_name, validate_payload  # noqa: E402

ROOT = Path(__file__).resolve().parent.parent
BOGOTA = timezone(timedelta(hours=-5))
RETRY_STATUSES = {408, 425, 429, 500, 502, 503, 504}
USER_AGENT = "segop-push-source/1.0"
PART_TARGET_BYTES = 200_000

log = logging.getLogger("push_source")


class PushError(Exception):
    def __init__(self, message: str, exit_code: int = 1):
        super().__init__(message)
        self.exit_code = exit_code


# --- configuración ------------------------------------------------------------
def load_config(path: Path) -> dict[str, Any]:
    try:
        config = json.loads(path.read_text(encoding="utf-8-sig"))
    except FileNotFoundError:
        raise PushError(f"no existe {path}; copia config.example.json como config.json", 2) from None
    except json.JSONDecodeError as exc:
        raise PushError(f"{path} no es JSON válido: {exc}", 2) from None
    if not isinstance(config.get("sources"), dict) or not config["sources"]:
        raise PushError(f'{path}: falta "sources"', 2)
    return config


def resolve_dir(config: dict[str, Any], key: str, default: str, base: Path) -> Path:
    directory = Path(config.get(key) or default)
    return directory if directory.is_absolute() else base / directory


def setup_logging(log_dir: Path, verbose: bool) -> None:
    log_dir.mkdir(parents=True, exist_ok=True)
    log.setLevel(logging.DEBUG if verbose else logging.INFO)
    log.handlers.clear()
    formatter = logging.Formatter("%(asctime)s %(levelname)s %(message)s")
    file_handler = logging.handlers.RotatingFileHandler(
        log_dir / "push_source.log", maxBytes=1_000_000, backupCount=5, encoding="utf-8"
    )
    file_handler.setFormatter(formatter)
    log.addHandler(file_handler)
    if sys.stderr is not None:  # con pythonw no hay consola
        console = logging.StreamHandler(sys.stderr)
        console.setFormatter(formatter)
        log.addHandler(console)


# --- estado (hash del último CSV enviado) ------------------------------------------
def read_state(state_dir: Path, source: str) -> dict[str, Any]:
    path = state_dir / f"{source}.json"
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (FileNotFoundError, json.JSONDecodeError):
        return {}


def write_state(state_dir: Path, source: str, state: dict[str, Any]) -> None:
    state_dir.mkdir(parents=True, exist_ok=True)
    path = state_dir / f"{source}.json"
    tmp = path.with_suffix(".tmp")
    tmp.write_text(json.dumps(state, ensure_ascii=False, indent=2), encoding="utf-8")
    os.replace(tmp, path)


# --- lectura de la fuente ------------------------------------------------------
def redact(text: str, secret: str | None) -> str:
    return text.replace(secret, "***") if secret else text


def fetch_bytes(url: str, secret: str | None, attempts: int = 3, timeout: float = 180) -> bytes:
    """GET con reintentos. `secret` se oculta en cualquier mensaje (va en la URL)."""
    for attempt in range(1, attempts + 1):
        request = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
        try:
            with urllib.request.urlopen(request, timeout=timeout) as response:
                return response.read()
        except urllib.error.HTTPError as exc:
            detail = redact(exc.read().decode("utf-8", "replace")[:500], secret)
            if exc.code not in RETRY_STATUSES or attempt == attempts:
                raise PushError(f"la API respondió HTTP {exc.code}: {detail}") from None
            log.warning("API HTTP %s (intento %s/%s)", exc.code, attempt, attempts)
        except (urllib.error.URLError, TimeoutError, ConnectionError) as exc:
            if attempt == attempts:
                raise PushError(f"error de red al consultar la API: {redact(str(exc), secret)}") from None
            log.warning("error de red con la API (intento %s/%s): %s", attempt, attempts, redact(str(exc), secret))
        time.sleep(2 ** attempt + random.uniform(0, 1))
    raise PushError("sin respuesta de la API")  # inalcanzable


def read_source(source: str, source_config: dict[str, Any]) -> bytes:
    """Bytes del CSV: de un archivo (csvPath) o de una API (type "http")."""
    if source_config.get("type") == "http":
        url = source_config.get("url") or ""
        if not url.startswith("https://") and not url.startswith("http://"):
            raise PushError(f'[{source}] falta "url" en config.json', 2)
        key_env = source_config.get("apiKeyEnv")
        secret = os.environ.get(key_env) if key_env else None
        if key_env and not secret:
            raise PushError(f"[{source}] falta la variable {key_env} (entorno o archivo --env-file)", 2)
        if secret:
            param = source_config.get("apiKeyParam") or "api-key"
            url += ("&" if "?" in url else "?") + urllib.parse.urlencode({param: secret})
        log.info("[%s] consultando %s", source, source_config["url"])
        started = time.monotonic()
        try:
            data = fetch_bytes(url, secret)
        except PushError as exc:
            raise PushError(f"[{source}] {exc}", exc.exit_code) from None
        log.info("[%s] API: %s bytes en %.1f s", source, len(data), time.monotonic() - started)
        return data

    csv_path = Path(source_config.get("csvPath") or "")
    try:
        return csv_path.read_bytes()
    except OSError as exc:
        raise PushError(f"[{source}] no se pudo leer {csv_path}: {exc}", 2) from None


def source_digest(data: bytes, source_config: dict[str, Any], related: bytes = b"") -> str:
    """Hash de los datos + la configuración de la fuente (+ los datos de fuentes
    relacionadas, p. ej. Planner para Sara): un cambio en cualquiera provoca un envío."""
    digest = hashlib.sha256(data)
    digest.update(json.dumps(source_config, sort_keys=True, ensure_ascii=False).encode("utf-8"))
    digest.update(related)
    return digest.hexdigest()


def read_related(source: str, source_config: dict[str, Any], sources: dict[str, Any]) -> tuple[bytes, list | None]:
    """Si la fuente usa otra como insumo (options.plannerSource), devuelve (bytes, tareas)."""
    name = (source_config.get("options") or {}).get("plannerSource")
    if not name:
        return b"", None
    related_config = sources.get(name)
    if related_config is None:
        raise PushError(f"[{source}] options.plannerSource = {name!r} no está en config.json", 2)
    data = read_source(name, related_config)
    columns, rows = parse_rows(data, related_config.get("delimiter") or ",", related_config.get("repairColumn"))
    try:
        result = run_adapter(related_config.get("adapter") or name, columns, rows, name)
    except AdapterError as exc:
        raise PushError(f"[{source}] no se pudo leer {name}: {exc}", 2) from None
    return data, result.tasks


# --- payload -----------------------------------------------------------------
def build_payload(
    source: str,
    source_config: dict[str, Any],
    data: bytes,
    now: datetime | None = None,
    planner_tasks: list | None = None,
) -> dict[str, Any]:
    info: dict[str, Any] = {}
    columns, rows = parse_rows(data, source_config.get("delimiter") or ",", source_config.get("repairColumn"), info)
    if info.get("repaired"):
        log.info("[%s] %s filas reparadas (delimitador sin comillas en %s)",
                 source, info["repaired"], source_config.get("repairColumn"))
    options = {
        **(source_config.get("options") or {}),
        "assignment": source_config.get("assignment"),
        "now": now or datetime.now(timezone.utc),
    }
    if planner_tasks is not None:
        options["plannerTasks"] = planner_tasks
    try:
        result = run_adapter(source_config.get("adapter") or source, columns, rows, source, options)
    except AdapterError as exc:
        raise PushError(f"[{source}] {exc}", 2) from None

    check = validate_payload(
        {"tasks": result.tasks, "warnings": result.warnings, "sourceData": result.source_data or None}, source
    )
    if check["error"]:
        raise PushError(f"[{source}] payload inválido: {check['error']}", 2)
    if check["rejected"]:
        raise PushError(
            f"[{source}] {len(check['invalid'])} de {len(result.tasks)} tareas inválidas; "
            "revisa el adaptador. No se envía nada.",
            2,
        )
    warnings = list(result.warnings)
    for item in check["invalid"]:
        detail = "; ".join(f"{e['field']}: {e['message']}" for e in item["errors"])
        log.warning("[%s] tarea inválida %s: %s", source, item["uid"], detail)
        warnings.append({"source": source, "sourceId": None, "code": "invalid_task", "message": detail})

    payload = {
        "tasks": check["tasks"],
        "warnings": warnings,
        "generatedAt": datetime.now(BOGOTA).isoformat(timespec="seconds"),
    }
    if result.source_data:
        payload["sourceData"] = result.source_data
    return payload


# --- envío -----------------------------------------------------------------------
def request_json(
    method: str, url: str, api_key: str, body: bytes | None = None, attempts: int = 4, timeout: float = 30
) -> dict[str, Any]:
    request_headers = {"x-api-key": api_key, "User-Agent": USER_AGENT}
    if body is not None:
        request_headers["Content-Type"] = "application/json; charset=utf-8"
    for attempt in range(1, attempts + 1):
        request = urllib.request.Request(url, data=body, method=method, headers=request_headers)
        try:
            with urllib.request.urlopen(request, timeout=timeout) as response:
                return json.loads(response.read().decode("utf-8") or "{}")
        except urllib.error.HTTPError as exc:
            detail = exc.read().decode("utf-8", "replace")[:2000]
            if exc.code not in RETRY_STATUSES or attempt == attempts:
                raise PushError(f"HTTP {exc.code}: {detail}") from None
            log.warning("HTTP %s (intento %s/%s): %s", exc.code, attempt, attempts, detail[:200])
        except (urllib.error.URLError, TimeoutError, ConnectionError) as exc:
            if attempt == attempts:
                raise PushError(f"error de red: {exc}") from None
            log.warning("error de red (intento %s/%s): %s", attempt, attempts, exc)
        time.sleep(2 ** attempt + random.uniform(0, 1))
    raise PushError("sin respuesta")  # inalcanzable


def split_parts(tasks: list[dict[str, Any]], target_bytes: int = PART_TARGET_BYTES) -> list[bytes]:
    """Agrupa las tareas en cuerpos {"tasks": [...]} de ~target_bytes (mínimo una parte).
    Cada parte debe ser pequeña: la Function la procesa dentro del límite de CPU."""
    groups: list[list[bytes]] = [[]]
    size = 0
    for task in tasks:
        encoded = json.dumps(task, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
        if groups[-1] and size + len(encoded) > target_bytes:
            groups.append([])
            size = 0
        groups[-1].append(encoded)
        size += len(encoded) + 1
    return [b'{"tasks":[' + b",".join(group) + b"]}" for group in groups]


def send_payload(base_url: str, api_key: str, source: str, payload: dict[str, Any]) -> dict[str, Any]:
    """Sube un payload por partes y lo publica (ver functions/_lib/service.js).

    Si sourceData trae la configuración de asignación, el reparto se calcula aquí a
    partir de los dueños vigentes en Cloudflare y de la carga de trabajo de cada
    validador (sourceData.workload: trabajo hecho en la ventana + Planner), y se
    publica el resultado."""
    url = f"{base_url}/api/ingest/{source}"
    source_data = dict(payload.get("sourceData") or {})
    config = source_data.pop("assignment", None)

    assignment = None
    if config is not None:
        state = request_json("GET", f"{url}/state", api_key)
        previous = state.get("owners") or {}
        now = datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")
        baseline = baseline_from_workload(source_data.get("workload"))
        result = assign_flights(payload["tasks"], previous, normalize_config(config), now, baseline)
        assignment = {"owners": result["owners"], "summary": result["summary"]}

    batch = secrets.token_hex(8)
    parts_info = []
    bodies = split_parts(payload["tasks"])
    for index, body in enumerate(bodies):
        part = request_json("POST", f"{url}/parts?batch={batch}&index={index}", api_key, body)
        if part.get("invalidIndexes"):
            for item in part.get("invalid") or []:
                log.warning("[%s] tarea rechazada por el servidor %s: %s", source, item.get("uid"), item.get("errors"))
        parts_info.append({
            "index": index,
            "length": part["length"],
            "received": part["received"],
            "invalidIndexes": part["invalidIndexes"],
        })
    log.info("[%s] %s parte(s) subidas (lote %s)", source, len(bodies), batch)

    commit = {
        "batch": batch,
        "parts": parts_info,
        "generatedAt": payload.get("generatedAt"),
        "warnings": payload.get("warnings") or [],
        "sourceData": source_data or None,
        "assignment": assignment,
    }
    response = request_json("POST", url, api_key, json.dumps(commit, ensure_ascii=False).encode("utf-8"))
    if assignment is not None:
        response["assignment"] = {**assignment["summary"]["counts"], "conflicts": len(assignment["summary"]["conflicts"])}
    return response


def push_source(
    source: str,
    source_config: dict[str, Any],
    state_dir: Path,
    *,
    dry_run: bool,
    force: bool,
    sources: dict[str, Any] | None = None,
) -> None:
    if not is_valid_source_name(source):
        raise PushError(f"nombre de fuente inválido: {source!r} (minúsculas, números, _ y -)", 2)
    data = read_source(source, source_config)
    related_data, planner_tasks = read_related(source, source_config, sources or {})
    digest = source_digest(data, source_config, related_data)

    base_url = os.environ.get("INGEST_URL", "").rstrip("/")
    api_key = os.environ.get(ingest_key_var(source)) or os.environ.get("INGEST_KEY")
    if not dry_run and (not base_url or not api_key):
        raise PushError("faltan INGEST_URL o INGEST_KEY (entorno o archivo --env-file)", 2)

    # El estado se guarda por URL de destino: enviar al servidor local no marca
    # como "enviado" el CSV para producción, y viceversa.
    state = read_state(state_dir, source)
    targets = state.setdefault("targets", {})
    if not dry_run and not force and targets.get(base_url, {}).get("sha256") == digest:
        log.info("[%s] sin cambios para %s (sha256 %s…); no se envía", source, base_url, digest[:12])
        return

    payload = build_payload(source, source_config, data, planner_tasks=planner_tasks)
    body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
    summary = f"{len(payload['tasks'])} tareas, {len(payload['warnings'])} warnings, {len(body)} bytes"

    if dry_run:
        if hasattr(sys.stdout, "reconfigure"):
            sys.stdout.reconfigure(encoding="utf-8")  # tildes intactas aunque se redirija a archivo
        print(json.dumps(payload, ensure_ascii=False, indent=2))
        log.info("[%s] dry-run: %s (no se envió)", source, summary)
        return
    log.info("[%s] enviando %s a %s", source, summary, base_url)
    try:
        response = send_payload(base_url, api_key, source, payload)
    except PushError as exc:
        raise PushError(f"[{source}] {exc}", exc.exit_code) from None

    log.info(
        "[%s] OK: aceptadas %s, inválidas %s, warnings %s, updatedAt %s",
        source, response.get("accepted"), response.get("invalidCount"),
        response.get("warningCount"), response.get("updatedAt"),
    )
    if response.get("assignment"):
        counts = response["assignment"]
        log.info(
            "[%s] asignación: conservados %s, nuevos %s, reasignados %s, liberados %s, conflictos %s",
            source, counts.get("kept"), counts.get("assigned"), counts.get("reassigned"),
            counts.get("released"), counts.get("conflicts"),
        )
    targets[base_url] = {
        "sha256": digest,
        "sentAt": datetime.now(BOGOTA).isoformat(timespec="seconds"),
        "accepted": response.get("accepted"),
        "updatedAt": response.get("updatedAt"),
    }
    write_state(state_dir, source, state)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Envía una fuente a /api/ingest/:source.")
    target = parser.add_mutually_exclusive_group(required=True)
    target.add_argument("source", nargs="?", help="nombre de la fuente en config.json")
    target.add_argument("--all", action="store_true", help="procesa todas las fuentes de config.json")
    parser.add_argument("--config", default=str(ROOT / "config.json"))
    parser.add_argument("--env-file", default=str(ROOT / ".env"))
    parser.add_argument("--dry-run", action="store_true", help="muestra el payload normalizado sin enviarlo")
    parser.add_argument("--force", action="store_true", help="envía aunque el CSV no haya cambiado")
    parser.add_argument("--verbose", action="store_true")
    args = parser.parse_args(argv)

    config_path = Path(args.config).resolve()
    try:
        config = load_config(config_path)
    except PushError as exc:
        print(f"ERROR: {exc}", file=sys.stderr or sys.stdout)
        return exc.exit_code
    base = config_path.parent
    setup_logging(resolve_dir(config, "logDir", "logs", base), args.verbose)
    state_dir = resolve_dir(config, "stateDir", ".state", base)
    load_env_file(args.env_file)

    sources = list(config["sources"]) if args.all else [args.source]
    exit_code = 0
    for source in sources:
        try:
            if source not in config["sources"]:
                raise PushError(f"la fuente {source!r} no está en {config_path.name}", 2)
            push_source(source, config["sources"][source], state_dir, dry_run=args.dry_run, force=args.force,
                        sources=config["sources"])
        except PushError as exc:
            log.error("%s", exc)
            exit_code = max(exit_code, exc.exit_code)
        except Exception:  # noqa: BLE001 - cualquier fallo inesperado debe quedar en el log
            log.exception("[%s] error inesperado", source)
            exit_code = max(exit_code, 1)
    return exit_code


if __name__ == "__main__":
    sys.exit(main())
