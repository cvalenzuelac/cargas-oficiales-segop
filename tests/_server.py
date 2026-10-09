"""Arranca dev_server.py en un hilo, con almacenamiento temporal, para los tests."""

import json
import tempfile
import threading
import urllib.error
import urllib.request
from pathlib import Path

import _path  # noqa: F401

import dev_server

API_KEY = "clave-de-prueba"


class RunningServer:
    def __init__(self, env=None):
        self._tmp = tempfile.TemporaryDirectory()
        self.data_dir = Path(self._tmp.name)
        self.env = {"INGEST_KEY": API_KEY, **(env or {})}
        self.server = dev_server.make_server(0, self.data_dir, self.env, quiet=True)
        self.url = f"http://127.0.0.1:{self.server.server_address[1]}"
        self._thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self._thread.start()

    @property
    def store(self):
        return self.server.RequestHandlerClass.func.store

    def close(self):
        self.server.shutdown()
        self.server.server_close()
        self._tmp.cleanup()

    def request(self, method, path, body=None, headers=None):
        """Devuelve (status, headers, json|None) sin lanzar en códigos 4xx/5xx."""
        data = json.dumps(body).encode("utf-8") if body is not None and not isinstance(body, bytes) else body
        request = urllib.request.Request(self.url + path, data=data, method=method, headers=headers or {})
        try:
            with urllib.request.urlopen(request, timeout=10) as response:
                raw = response.read()
                return response.status, response.headers, json.loads(raw) if raw else None
        except urllib.error.HTTPError as exc:
            raw = exc.read()
            try:
                parsed = json.loads(raw) if raw else None
            except json.JSONDecodeError:
                parsed = None
            return exc.code, exc.headers, parsed
