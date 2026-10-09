"""Contrato HTTP del servidor local (el mismo que deben cumplir las Functions)."""

import copy
import json
import unittest

import _path

from _server import API_KEY, RunningServer

SCHEMA = json.loads((_path.FIXTURES / "schema_cases.json").read_text(encoding="utf-8"))
JSON_HEADERS = {"Content-Type": "application/json"}


def task(source, source_id, **overrides):
    base = copy.deepcopy(SCHEMA["baseTask"])
    base.update({"uid": f"{source}:{source_id}", "source": source, "sourceId": source_id})
    base.update(overrides)
    return base


class DevServerTest(unittest.TestCase):
    def setUp(self):
        self.srv = RunningServer()

    def tearDown(self):
        self.srv.close()

    def auth(self, key=API_KEY):
        return {**JSON_HEADERS, "x-api-key": key} if key is not None else dict(JSON_HEADERS)

    def part(self, source, tasks, batch="lote0001", index=0, key=API_KEY):
        return self.srv.request("POST", f"/api/ingest/{source}/parts?batch={batch}&index={index}",
                                {"tasks": tasks}, self.auth(key))

    def commit(self, source, parts, batch="lote0001", key=API_KEY, **extra):
        return self.srv.request("POST", f"/api/ingest/{source}", {"batch": batch, "parts": parts, **extra},
                                self.auth(key))

    def publish(self, source, chunks, batch="lote0001", **extra):
        """Sube las partes y publica, como hace push_source.py."""
        infos = []
        for i, tasks in enumerate(chunks):
            status, _, body = self.part(source, tasks, batch, i)
            self.assertEqual(status, 200, body)
            infos.append({k: body[k] for k in ("length", "received", "invalidIndexes")} | {"index": i})
        status, _, body = self.commit(source, infos, batch, **extra)
        self.assertEqual(status, 200, body)
        return body

    # --- autenticación ---------------------------------------------------------
    def test_every_ingest_route_requires_key(self):
        self.assertEqual(self.part("planner", [task("planner", "T1")], key=None)[0], 401)
        self.assertEqual(self.part("planner", [task("planner", "T1")], key="otra")[0], 401)
        self.assertEqual(self.commit("planner", [], key=None)[0], 401)
        self.assertEqual(self.srv.request("GET", "/api/ingest/planner/state")[0], 401)
        self.assertEqual(self.srv.store.writes, 0)

    def test_per_source_key_takes_precedence(self):
        self.srv.close()
        self.srv = RunningServer({"INGEST_KEY_PLANNER": "solo-planner"})
        self.assertEqual(self.part("planner", [])[0], 401)
        self.assertEqual(self.part("planner", [], key="solo-planner")[0], 200)
        self.assertEqual(self.part("otra", [])[0], 200)

    # --- partes -------------------------------------------------------------------
    def test_part_is_validated_and_stored_as_received(self):
        tasks = [task("planner", f"T{i}") for i in range(10)] + [task("planner", "X", priority="alta")]
        status, _, body = self.part("planner", tasks)
        self.assertEqual(status, 200)
        self.assertEqual((body["received"], body["accepted"], body["invalidIndexes"]), (11, 10, [10]))
        self.assertEqual(body["invalid"][0]["errors"][0]["field"], "priority")
        self.assertEqual(self.srv.store.keys(), ["part:planner:lote0001:0"])
        stored = self.srv.store.get_part_text("planner", "lote0001", 0)
        self.assertEqual(json.loads(stored), {"tasks": tasks})
        self.assertEqual(body["length"], len(stored))

    def test_part_rejected_over_threshold(self):
        status, _, body = self.part("planner", [task("planner", "T1"), task("planner", "T2", status="")])
        self.assertEqual(status, 422)
        self.assertEqual(body["invalidCount"], 1)
        self.assertEqual(self.srv.store.writes, 0)

    def test_part_bad_requests(self):
        self.assertEqual(self.part("Planner", [])[0], 400)
        self.assertEqual(self.part("planner", [], batch="x")[0], 400)
        for index in ("-1", "01", "abc", "200"):
            status, _, _ = self.srv.request("POST", f"/api/ingest/planner/parts?batch=lote0001&index={index}",
                                            {"tasks": []}, self.auth())
            self.assertEqual(status, 400, index)
        status, _, _ = self.srv.request("POST", "/api/ingest/planner/parts?batch=lote0001&index=0",
                                        b"{no json", self.auth())
        self.assertEqual(status, 400)

    def test_part_too_large(self):
        big = b'{"tasks": [], "x": "' + b"a" * (1024 * 1024) + b'"}'
        status, _, _ = self.srv.request("POST", "/api/ingest/planner/parts?batch=lote0001&index=0", big, self.auth())
        self.assertEqual(status, 413)

    # --- publicación -----------------------------------------------------------------
    def test_commit_publishes_and_writes_two_keys(self):
        _, _, p = self.part("planner", [task("planner", "T1")])
        writes = self.srv.store.writes
        status, _, body = self.commit(
            "planner", [{"index": 0, "length": p["length"], "received": 1, "invalidIndexes": []}],
            warnings=[{"source": "planner", "sourceId": "T1", "code": "x", "message": "m"}], generatedAt="g",
        )
        self.assertEqual(status, 200, body)
        self.assertEqual((body["accepted"], body["warningCount"], body["kvWrites"]), (1, 1, 2))
        self.assertTrue(body["updatedAt"].endswith("Z"))
        self.assertEqual(self.srv.store.writes - writes, 2)

    def test_commit_bad_requests(self):
        self.assertEqual(self.commit("planner", [])[0], 400)
        status, _, body = self.commit("planner", [{"index": 0, "length": 20, "received": 5, "invalidIndexes": [0, 1]}])
        self.assertEqual(status, 422)
        self.assertEqual(self.srv.store.writes, 0)

    def test_new_version_deletes_previous_parts(self):
        self.publish("planner", [[task("planner", "T1")], [task("planner", "T2")]], batch="lote0001")
        self.publish("planner", [[task("planner", "T3")]], batch="lote0002")
        self.assertEqual(self.srv.store.deletes, 2)
        self.assertEqual(self.srv.store.keys(), ["index", "meta:planner", "part:planner:lote0002:0"])

    def test_state_returns_current_owners(self):
        status, _, body = self.srv.request("GET", "/api/ingest/sara/state", headers=self.auth())
        self.assertEqual((status, body), (200, {"updatedAt": None, "owners": {}}))
        owners = {"F1": {"owner": "a@x.com", "since": "t"}}
        self.publish("sara", [[]], assignment={"owners": owners, "summary": {"counts": {}}})
        _, _, body = self.srv.request("GET", "/api/ingest/sara/state", headers=self.auth())
        self.assertEqual(body["owners"], owners)

    # --- lectura -------------------------------------------------------------------------
    def test_data_empty_before_any_ingest(self):
        status, headers, body = self.srv.request("GET", "/api/data")
        self.assertEqual(status, 200)
        self.assertEqual(body, {"generatedAt": None, "sources": {}, "parts": {}})
        self.assertTrue(headers["ETag"])

    def test_data_returns_meta_and_chunks(self):
        first = [task("planner", f"T{i}") for i in range(10)]
        first.insert(4, task("planner", "X", priority="alta"))
        chunks = [first, [task("planner", "Z")]]
        self.publish("planner", chunks, sourceData={"k": 1})
        _, _, data = self.srv.request("GET", "/api/data")
        self.assertEqual(data["sources"]["planner"]["count"], 11)
        part = data["parts"]["planner"]
        self.assertEqual([c["tasks"] for c in part["chunks"]], chunks)
        self.assertEqual([p["invalidIndexes"] for p in part["meta"]["parts"]], [[4], []])
        self.assertEqual(part["meta"]["sourceData"], {"k": 1})
        self.assertEqual(part["meta"]["updatedAt"], data["generatedAt"])

    def test_inconsistent_parts_are_served_without_etag(self):
        """Si KV aún no propagó una parte de la versión publicada, no se entrega ETag."""
        self.publish("planner", [[task("planner", "T1")]])
        self.srv.store.put_part("planner", "lote0001", 0, '{"tasks":[]}')  # otra versión
        status, headers, _ = self.srv.request("GET", "/api/data")
        self.assertEqual(status, 200)
        self.assertIsNone(headers.get("ETag"))
        self.assertEqual(headers["Cache-Control"], "no-store")

    def test_etag_and_304(self):
        self.publish("planner", [[task("planner", "T1")]])
        status, headers, _ = self.srv.request("GET", "/api/data")
        self.assertEqual(status, 200)
        etag = headers["ETag"]

        status, headers, body = self.srv.request("GET", "/api/data", headers={"If-None-Match": etag})
        self.assertEqual(status, 304)
        self.assertIsNone(body)
        self.assertEqual(headers["ETag"], etag)
        self.assertEqual(self.srv.request("GET", "/api/data", headers={"If-None-Match": f'"otro", W/{etag}'})[0], 304)

        self.publish("planner", [[task("planner", "T2")]], batch="lote0002")
        status, headers, _ = self.srv.request("GET", "/api/data", headers={"If-None-Match": etag})
        self.assertEqual(status, 200)
        self.assertNotEqual(headers["ETag"], etag)

    def test_two_sources_are_served_and_republish_replaces_one(self):
        # La unificación de personas la hace el navegador (public/js/lib/dataset.js; tests/js/).
        self.publish("planner", [[task("planner", "T1")]])
        self.publish("auditorias", [[task("auditorias", "A1")]])
        self.publish("planner", [[]], batch="lote0002")
        _, _, data = self.srv.request("GET", "/api/data")
        self.assertEqual(set(data["parts"]), {"planner", "auditorias"})
        self.assertEqual(data["sources"]["planner"]["count"], 0)
        self.assertEqual(len(data["parts"]["auditorias"]["chunks"][0]["tasks"]), 1)

    def test_health_has_no_personal_data(self):
        status, _, body = self.srv.request("GET", "/api/health")
        self.assertEqual((status, body["status"]), (200, "empty"))
        self.publish("planner", [[task("planner", "T1")]])
        _, _, body = self.srv.request("GET", "/api/health")
        self.assertEqual(body["status"], "ok")
        self.assertEqual(body["sources"]["planner"]["count"], 1)
        self.assertNotIn("@", json.dumps(body))

    # --- rutas -------------------------------------------------------------------
    def test_methods_and_unknown_routes(self):
        self.assertEqual(self.srv.request("GET", "/api/ingest/planner", headers=self.auth())[0], 405)
        self.assertEqual(self.srv.request("POST", "/api/ingest/planner/state", b"{}", self.auth())[0], 405)
        self.assertEqual(self.srv.request("POST", "/api/ingest/planner/otra", b"{}", self.auth())[0], 404)
        self.assertEqual(self.srv.request("POST", "/api/data", b"")[0], 405)
        self.assertEqual(self.srv.request("GET", "/api/nada")[0], 404)

    def test_serves_static_index(self):
        import urllib.request

        with urllib.request.urlopen(self.srv.url + "/", timeout=10) as response:
            self.assertEqual(response.status, 200)
            self.assertIn(b'src="js/index.js"', response.read())


if __name__ == "__main__":
    unittest.main()
