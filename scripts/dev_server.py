"""Servidor local de desarrollo: emula Cloudflare Pages + Functions + KV.

    python scripts/dev_server.py [--port 8787] [--data-dir .local-data]

- Sirve public/ como sitio estático.
- Emula POST /api/ingest/:source, GET /api/data y GET /api/health con el mismo
  contrato que las Functions (payloads, códigos, ETag/304, x-api-key).
- KV se reemplaza por archivos JSON en .local-data/ (ignorada por git).
- La clave se toma de INGEST_KEY / INGEST_KEY_<FUENTE> (entorno o archivo .env).
- Cloudflare Access no aplica en local.
- Pruebas de las Functions en JS (en el navegador): http://127.0.0.1:8787/__tests__/
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import threading
import urllib.parse
from functools import partial
from http import HTTPStatus
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any

sys.path.insert(0, str(Path(__file__).resolve().parent))

from common.env import load_env_file  # noqa: E402
from common.ingest import (  # noqa: E402
    MAX_BODY_BYTES,
    data_response,
    etag_matches,
    handle_ingest_route,
    health,
    serialize,
)

ROOT = Path(__file__).resolve().parent.parent
INGEST_PREFIX = "/api/ingest/"
DEV_MOUNTS = {
    "/__tests__/": ROOT / "tests" / "js",
    "/__functions__/": ROOT / "functions",
    "/__fixtures__/": ROOT / "fixtures",
}


class LocalStore:
    """Equivalente local de functions/_lib/storage.js: un archivo por clave de KV."""

    def __init__(self, directory: Path):
        self.directory = Path(directory)
        self.directory.mkdir(parents=True, exist_ok=True)
        self.writes = 0
        self.deletes = 0

    def _path(self, key: str) -> Path:
        return self.directory / (key.replace(":", "__") + ".json")

    def _read_text(self, key: str) -> str | None:
        path = self._path(key)
        return path.read_text(encoding="utf-8") if path.is_file() else None

    def _write_text(self, key: str, text: str) -> None:
        path = self._path(key)
        tmp = path.with_suffix(".tmp")
        tmp.write_text(text, encoding="utf-8")
        os.replace(tmp, path)
        self.writes += 1

    def get_index_text(self):
        return self._read_text("index")

    def put_index(self, index):
        self._write_text("index", serialize(index))

    def get_meta_text(self, source):
        return self._read_text(f"meta:{source}")

    def get_meta(self, source):
        text = self.get_meta_text(source)
        return json.loads(text) if text else None

    def put_meta(self, source, meta):
        self._write_text(f"meta:{source}", serialize(meta))

    def put_part(self, source, batch, index, text):
        self._write_text(f"part:{source}:{batch}:{index}", text)

    def get_part_text(self, source, batch, index):
        return self._read_text(f"part:{source}:{batch}:{index}")

    def delete_part(self, source, batch, index):
        self._path(f"part:{source}:{batch}:{index}").unlink(missing_ok=True)
        self.deletes += 1

    def keys(self):
        return sorted(p.stem.replace("__", ":") for p in self.directory.glob("*.json"))


class DevHandler(SimpleHTTPRequestHandler):
    store: LocalStore
    env: dict[str, str]
    js_results: dict[str, Any]
    lock = threading.Lock()
    extensions_map = {
        **SimpleHTTPRequestHandler.extensions_map,
        ".js": "text/javascript",
        ".json": "application/json",
        ".css": "text/css",
    }

    def translate_path(self, path):
        # Rutas solo locales para la página de pruebas JS (no existen en Cloudflare).
        for prefix, directory in DEV_MOUNTS.items():
            if path.startswith(prefix):
                original = self.directory
                self.directory = str(directory)
                try:
                    return super().translate_path("/" + path[len(prefix):])
                finally:
                    self.directory = original
        return super().translate_path(path)

    def end_headers(self):
        # Sin caché del navegador para los estáticos durante el desarrollo.
        if not self.path.startswith("/api/"):
            self.send_header("Cache-Control", "no-store")
        super().end_headers()

    # --- respuestas -----------------------------------------------------------
    def _send_json(self, status: int, data: Any, headers: dict[str, str] | None = None) -> None:
        body = json.dumps(data, ensure_ascii=False).encode("utf-8")
        self._send_body(status, body, headers)

    def _send_body(self, status: int, body: bytes, headers: dict[str, str] | None = None) -> None:
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("X-Content-Type-Options", "nosniff")
        for name, value in (headers or {}).items():
            self.send_header(name, value)
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(body)

    def _method_not_allowed(self, allowed: str) -> None:
        self._send_json(405, {"error": "método no permitido"}, {"Allow": allowed})

    # --- rutas ----------------------------------------------------------------
    def _route(self) -> str:
        return self.path.split("?", 1)[0]

    def do_GET(self):
        route = self._route()
        if route in ("/api/data", "/api/data/"):
            return self._get_data()
        if route in ("/api/health", "/api/health/"):
            return self._send_json(200, health(self.store), {"Cache-Control": "no-store"})
        if route.startswith(INGEST_PREFIX):
            return self._ingest()
        if route.startswith("/api/"):
            return self._send_json(404, {"error": "ruta no encontrada"})
        return super().do_GET()

    def do_HEAD(self):
        if self._route().startswith("/api/"):
            return self._method_not_allowed("GET")
        return super().do_HEAD()

    def do_POST(self):
        route = self._route()
        if route == "/__tests__/results":
            return self._store_js_results()
        if route.startswith(INGEST_PREFIX):
            return self._ingest()
        if route in ("/api/data", "/api/health"):
            return self._method_not_allowed("GET")
        return self._send_json(404, {"error": "ruta no encontrada"})

    def _ingest(self):
        """/api/ingest/* con el mismo contrato que functions/api/ingest/[[path]].js."""
        parsed = urllib.parse.urlsplit(self.path)
        path = [urllib.parse.unquote(s) for s in parsed.path[len(INGEST_PREFIX):].split("/") if s]
        query = dict(urllib.parse.parse_qsl(parsed.query))
        body = b""
        if self.command == "POST":
            try:
                length = int(self.headers.get("Content-Length") or 0)
            except ValueError:
                length = -1
            if length < 0:
                return self._send_json(400, {"error": "Content-Length inválido"})
            if length > MAX_BODY_BYTES:
                self._discard(length)
                return self._send_json(413, {"error": f"el cuerpo supera {MAX_BODY_BYTES} bytes"})
            body = self.rfile.read(length)
        try:
            with self.lock:
                status, data, allow = handle_ingest_route(
                    self.store, path, self.command, query, self.headers.get("x-api-key"), body, self.env
                )
        except OSError as exc:  # p. ej. ruta de .local-data demasiado larga en Windows
            self.log_error("error de almacenamiento: %s", exc)
            return self._send_json(500, {"error": f"error de almacenamiento local: {exc}"})
        headers = {"Cache-Control": "no-store"}
        if allow:
            headers["Allow"] = allow
        self._send_json(status, data, headers)

    def _store_js_results(self):
        """Recibe el resumen de la página /__tests__/ (lo lee tests/test_js_functions.py)."""
        length = int(self.headers.get("Content-Length") or 0)
        try:
            self.js_results["last"] = json.loads(self.rfile.read(min(length, 1_000_000)))
        except json.JSONDecodeError:
            return self._send_json(400, {"error": "JSON inválido"})
        failed = len(self.js_results["last"].get("failures", []))
        self.log_message("pruebas JS: %s/%s OK", self.js_results["last"].get("passed"), self.js_results["last"].get("total"))
        self._send_json(200, {"ok": failed == 0})

    def _discard(self, length: int, limit: int = 4 * MAX_BODY_BYTES) -> None:
        """Consume el cuerpo rechazado para que el cliente reciba la respuesta y no un reset."""
        remaining = min(length, limit)
        while remaining > 0:
            chunk = self.rfile.read(min(remaining, 65536))
            if not chunk:
                break
            remaining -= len(chunk)
        if length > limit:
            self.close_connection = True

    def _get_data(self):
        etag, build = data_response(self.store)
        headers = {"ETag": etag, "Cache-Control": "private, no-cache"}
        if etag_matches(self.headers.get("If-None-Match"), etag):
            self.send_response(HTTPStatus.NOT_MODIFIED)
            for name, value in headers.items():
                self.send_header(name, value)
            self.end_headers()
            return
        text, consistent = build()
        self._send_body(200, text.encode("utf-8"), headers if consistent else {"Cache-Control": "no-store"})


def make_server(
    port: int, data_dir: Path, env: dict[str, str], host: str = "127.0.0.1", quiet: bool = False
) -> ThreadingHTTPServer:
    # Subclase por servidor para que cada instancia (p. ej. en tests) tenga su propio almacenamiento.
    attrs: dict[str, Any] = {
        "store": LocalStore(data_dir), "env": env, "lock": threading.Lock(), "js_results": {},
    }
    if quiet:
        attrs["log_message"] = lambda self, *args: None
    handler_cls = type("BoundDevHandler", (DevHandler,), attrs)
    handler = partial(handler_cls, directory=str(ROOT / "public"))
    return ThreadingHTTPServer((host, port), handler)


def main() -> int:
    parser = argparse.ArgumentParser(description="Servidor local que emula Pages + Functions + KV.")
    parser.add_argument("--port", type=int, default=8787)
    parser.add_argument("--data-dir", default=str(ROOT / ".local-data"))
    parser.add_argument("--env-file", default=str(ROOT / ".env"))
    args = parser.parse_args()

    load_env_file(args.env_file)
    if not os.environ.get("INGEST_KEY"):
        print("AVISO: INGEST_KEY no está definida (entorno o .env); las ingestas responderán 500.")
    try:
        server = make_server(args.port, Path(args.data_dir), dict(os.environ))
    except OSError as exc:
        print(f"No se pudo abrir el puerto {args.port}: {exc}. ¿Ya hay un dev_server corriendo?")
        return 1
    print(f"dev_server en http://127.0.0.1:{args.port}  (datos: {args.data_dir})  Ctrl+C para detener")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
