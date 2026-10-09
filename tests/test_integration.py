"""Pruebas de integración contra un deployment real de Cloudflare Pages (preview).

Se omiten si no está PREVIEW_URL. Variables:
    PREVIEW_URL                   p. ej. https://mi-rama.<proyecto>.pages.dev
    PREVIEW_INGEST_KEY            el secreto INGEST_KEY del entorno Preview
    PREVIEW_ACCESS_CLIENT_ID      opcional: service token de Access para leer /api/data
    PREVIEW_ACCESS_CLIENT_SECRET  y /api/health si el preview está detrás de Access

Usan las fuentes ficticias "itest-a" e "itest-b" y al terminar las dejan vacías.
Úsalas solo con el namespace KV de preview, nunca contra producción.

    $env:PREVIEW_URL="https://..."; $env:PREVIEW_INGEST_KEY="..."
    python -m unittest discover -s tests -p "test_integration.py" -v
"""

import json
import os
import time
import unittest
import urllib.error
import urllib.request

import _path  # noqa: F401

import push_source

PREVIEW_URL = os.environ.get("PREVIEW_URL", "").rstrip("/")
INGEST_KEY = os.environ.get("PREVIEW_INGEST_KEY", "")
ACCESS_ID = os.environ.get("PREVIEW_ACCESS_CLIENT_ID", "")
ACCESS_SECRET = os.environ.get("PREVIEW_ACCESS_CLIENT_SECRET", "")
CONSISTENCY_TIMEOUT_S = 90  # KV es eventualmente consistente (~60 s)
SOURCES = ("itest-a", "itest-b")


def task(source, source_id, assignees, **extra):
    return {
        "uid": f"{source}:{source_id}", "source": source, "sourceId": source_id,
        "title": f"Prueba de integración {source_id}", "assignees": assignees, "labels": ["itest"],
        "status": "in_progress", "priority": "medium",
        "createdAt": "2026-09-01T08:00:00-05:00", "closedAt": None, "extra": extra,
    }


def request(method, path, body=None, headers=None):
    all_headers = {"User-Agent": "segop-integration-tests/1.0", **(headers or {})}
    if ACCESS_ID and ACCESS_SECRET:
        all_headers.update({"CF-Access-Client-Id": ACCESS_ID, "CF-Access-Client-Secret": ACCESS_SECRET})
    data = None
    if body is not None:
        data = json.dumps(body).encode("utf-8")
        all_headers["Content-Type"] = "application/json"
    req = urllib.request.Request(PREVIEW_URL + path, data=data, method=method, headers=all_headers)
    try:
        with urllib.request.urlopen(req, timeout=30) as response:
            raw = response.read()
            return response.status, response.headers, json.loads(raw) if raw else None
    except urllib.error.HTTPError as exc:
        raw = exc.read()
        try:
            parsed = json.loads(raw) if raw else None
        except json.JSONDecodeError:
            parsed = raw[:300]
        return exc.code, exc.headers, parsed


def published_tasks(data, source):
    """Tareas publicadas de una fuente con sus dueños aplicados (como dataset.js, sin unificar personas)."""
    part = data["parts"][source]
    meta = part["meta"]
    owners = (meta.get("assignment") or {}).get("owners") or {}
    tasks = {}
    for info, chunk in zip(meta["parts"], part["chunks"]):
        for i, t in enumerate(chunk["tasks"]):
            if i not in info["invalidIndexes"]:
                if meta.get("assignment"):
                    owner = owners.get(t["sourceId"])
                    t = {**t, "assignees": [{"email": owner["owner"]}] if owner else []}
                tasks[t["uid"]] = t
    return tasks


def publish(source, tasks, source_data=None):
    payload = {"tasks": tasks, "warnings": [], "generatedAt": None}
    if source_data:
        payload["sourceData"] = source_data
    return push_source.send_payload(PREVIEW_URL, INGEST_KEY, source, payload)


@unittest.skipUnless(PREVIEW_URL and INGEST_KEY, "define PREVIEW_URL y PREVIEW_INGEST_KEY para correrlas")
class PreviewIntegrationTest(unittest.TestCase):
    @classmethod
    def tearDownClass(cls):
        for source in SOURCES:
            try:
                publish(source, [])
            except push_source.PushError:
                pass

    def test_01_ingest_requires_key(self):
        part = "/api/ingest/itest-a/parts?batch=itest0001&index=0"
        self.assertEqual(request("POST", part, {"tasks": []})[0], 401)
        self.assertEqual(request("POST", part, {"tasks": []}, {"x-api-key": "clave-incorrecta"})[0], 401)
        self.assertEqual(request("GET", "/api/ingest/itest-a/state")[0], 401)

    def test_02_health_is_reachable(self):
        status, _, body = request("GET", "/api/health")
        self.assertEqual(status, 200, f"¿Access bloquea /api/health? Respuesta: {body}")
        self.assertIn(body["status"], ("ok", "empty"))

    def test_03_two_sources_assignment_and_etag(self):
        ana = {"key": "itest.ana@example.com", "name": "Itest Ana Pérez", "email": "itest.ana@example.com"}
        body = publish("itest-a", [task("itest-a", "A1", [ana])])
        self.assertEqual(body["accepted"], 1)

        # itest-b con asignación persistente: el dueño se conserva en una segunda publicación.
        flights = [task("itest-b", f"B{i}", [], openEvents=i + 1, olderOpenEvents=0) for i in range(3)]
        config = {"validators": [{"email": "itest.ana@example.com"}, {"email": "itest.luis@example.com"}]}
        first = publish("itest-b", flights, {"assignment": config})
        self.assertEqual(first["assignment"]["assigned"], 3)
        second = publish("itest-b", flights, {"assignment": config})
        self.assertEqual(second["assignment"]["kept"], 3)
        updated_b = second["updatedAt"]

        # Espera a que /api/data refleje la última publicación (consistencia eventual).
        deadline = time.monotonic() + CONSISTENCY_TIMEOUT_S
        data, headers = None, None
        while time.monotonic() < deadline:
            status, headers, data = request("GET", "/api/data")
            self.assertEqual(status, 200, f"¿Access bloquea /api/data? Respuesta: {data}")
            if data["sources"].get("itest-b", {}).get("updatedAt") == updated_b and headers.get("ETag"):
                break
            time.sleep(5)
        self.assertEqual(data["sources"]["itest-b"]["updatedAt"], updated_b, "el dataset no se actualizó a tiempo")

        self.assertIn("itest-a:A1", published_tasks(data, "itest-a"))
        flights_b = published_tasks(data, "itest-b")
        self.assertTrue(all(len(flights_b[f"itest-b:B{i}"]["assignees"]) == 1 for i in range(3)))

        etag = headers["ETag"]
        status, _, _ = request("GET", "/api/data", headers={"If-None-Match": etag})
        self.assertEqual(status, 304)


if __name__ == "__main__":
    unittest.main()
