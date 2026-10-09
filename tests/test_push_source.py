import contextlib
import io
import json
import os
import shutil
import tempfile
import unittest
import urllib.error
from pathlib import Path
from unittest import mock

import _path

import push_source
from _server import API_KEY, RunningServer

FIXTURE_CSV = _path.FIXTURES / "planner_sample.csv"


class PushSourceTest(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.tmp = Path(self._tmp.name)
        self.csv = self.tmp / "planner.csv"
        shutil.copy(FIXTURE_CSV, self.csv)
        self.config = self.tmp / "config.json"
        self.config.write_text(json.dumps({
            "stateDir": "state",
            "logDir": "logs",
            "sources": {"planner": {"csvPath": str(self.csv), "adapter": "planner", "delimiter": ","}},
        }), encoding="utf-8")
        self.srv = RunningServer()
        self.env = mock.patch.dict(os.environ, {"INGEST_URL": self.srv.url, "INGEST_KEY": API_KEY})
        self.env.start()
        for name in [k for k in os.environ if k.startswith("INGEST_KEY_")]:
            os.environ.pop(name)

    def tearDown(self):
        self.env.stop()
        self.srv.close()
        for handler in push_source.log.handlers:
            handler.close()
        push_source.log.handlers.clear()
        self._tmp.cleanup()

    def run_main(self, *args):
        argv = [*args, "--config", str(self.config), "--env-file", str(self.tmp / "no-existe.env")]
        stderr = io.StringIO()
        with contextlib.redirect_stderr(stderr):
            code = push_source.main(argv)
        return code, stderr.getvalue()

    def published_uids(self, source):
        _, _, data = self.srv.request("GET", "/api/data")
        part = data["parts"][source]
        return [t["uid"] for chunk in part["chunks"] for t in chunk["tasks"]]

    def state(self, url=None):
        path = self.tmp / "state" / "planner.json"
        if not path.exists():
            return None
        return json.loads(path.read_text(encoding="utf-8"))["targets"].get(url or self.srv.url)

    # --- payload ----------------------------------------------------------------
    def test_build_payload(self):
        payload = push_source.build_payload("planner", {"adapter": "planner"}, FIXTURE_CSV.read_bytes())
        self.assertEqual(len(payload["tasks"]), 7)
        self.assertTrue(payload["generatedAt"].endswith("-05:00"))
        codes = {w["code"] for w in payload["warnings"]}
        self.assertIn("assignee_email_mismatch", codes)

    # --- flujo completo contra dev_server -------------------------------------------
    def test_send_then_skip_unchanged_then_force(self):
        code, _ = self.run_main("planner")
        self.assertEqual(code, 0)
        self.assertEqual(self.srv.store.writes, 3)
        state = self.state()
        self.assertEqual(state["accepted"], 7)
        self.assertEqual(len(state["sha256"]), 64)

        code, out = self.run_main("planner")
        self.assertEqual(code, 0)
        self.assertIn("sin cambios", out)
        self.assertEqual(self.srv.store.writes, 3)

        code, _ = self.run_main("planner", "--force")
        self.assertEqual(code, 0)
        self.assertEqual(self.srv.store.writes, 6)

    def test_state_is_per_target_url(self):
        self.assertEqual(self.run_main("planner")[0], 0)
        other = RunningServer()
        try:
            os.environ["INGEST_URL"] = other.url
            self.assertEqual(self.run_main("planner")[0], 0)
            self.assertEqual(other.store.writes, 3)  # no se saltó por el envío al otro destino
            self.assertIsNotNone(self.state(other.url))
            self.assertIsNotNone(self.state(self.srv.url))
        finally:
            other.close()

    def test_changed_csv_is_sent(self):
        self.run_main("planner")
        with open(self.csv, "a", encoding="utf-8", newline="") as handle:
            handle.write("T9,Nueva,,,,No iniciada,Baja,2026-09-09 09:00,\r\n")
        code, _ = self.run_main("planner")
        self.assertEqual(code, 0)
        self.assertEqual(self.state()["accepted"], 8)
        self.assertIn("planner:T9", self.published_uids("planner"))

    def test_all_sources(self):
        self.assertEqual(self.run_main("--all")[0], 0)
        self.assertIsNotNone(self.state())

    def test_dry_run_prints_and_does_not_send(self):
        stdout = io.StringIO()
        with contextlib.redirect_stdout(stdout):
            code, _ = self.run_main("planner", "--dry-run")
        self.assertEqual(code, 0)
        payload = json.loads(stdout.getvalue())
        self.assertEqual(len(payload["tasks"]), 7)
        self.assertEqual(self.srv.store.writes, 0)
        self.assertIsNone(self.state())

    def test_log_file_is_written(self):
        self.run_main("planner")
        log_text = (self.tmp / "logs" / "push_source.log").read_text(encoding="utf-8")
        self.assertIn("[planner] OK", log_text)

    # --- errores ------------------------------------------------------------------
    def test_wrong_key_fails_without_saving_state(self):
        os.environ["INGEST_KEY"] = "incorrecta"
        code, out = self.run_main("planner")
        self.assertEqual(code, 1)
        self.assertIn("HTTP 401", out)
        self.assertIsNone(self.state())

    def test_missing_env_is_config_error(self):
        os.environ.pop("INGEST_URL")
        self.assertEqual(self.run_main("planner")[0], 2)

    def test_unknown_source_and_missing_config(self):
        self.assertEqual(self.run_main("otra")[0], 2)
        self.config.unlink()
        self.assertEqual(self.run_main("planner")[0], 2)

    def test_missing_csv(self):
        self.csv.unlink()
        code, out = self.run_main("planner")
        self.assertEqual(code, 2)
        self.assertIn("no se pudo leer", out)

    # --- fuente HTTP (API de Sara simulada por dev_server en /__fixtures__/) ----------
    SECRET = "secreto-sara-123"

    def add_sara_source(self, path="/__fixtures__/sara_sample.csv", **overrides):
        config = json.loads(self.config.read_text(encoding="utf-8"))
        config["sources"]["sara"] = {
            "type": "http",
            "url": self.srv.url + path,
            "apiKeyEnv": "SARA_TEST_KEY",
            "apiKeyParam": "erg-api-key",
            "adapter": "sara",
            "delimiter": ",",
            "repairColumn": "eventname",
            # Pesos de las etiquetas del CSV ficticio de Planner (fixtures/planner_sample.csv).
            "options": {"windowDays": 100000, "workWindowDays": 100000, "plannerSource": "planner",
                        "plannerWeights": {"Auditoría": 15, "Seguimiento": 5}},
            "assignment": {"validators": [{"email": "ana.perez@example.com"}, {"email": "luis.gomez@example.com"}]},
            **overrides,
        }
        self.config.write_text(json.dumps(config), encoding="utf-8")
        os.environ["SARA_TEST_KEY"] = self.SECRET

    def tearDownSara(self):
        os.environ.pop("SARA_TEST_KEY", None)

    @mock.patch("push_source.time.sleep")
    def test_http_source_end_to_end_with_assignment(self, sleep):
        self.addCleanup(self.tearDownSara)
        self.add_sara_source()
        code, out = self.run_main("sara")
        self.assertEqual(code, 0, out)
        self.assertIn("asignación: conservados 0, nuevos 3", out)
        self.assertNotIn(self.SECRET, out)
        self.assertEqual(sorted(self.published_uids("sara")), ["sara:1001", "sara:1002", "sara:1004"])
        meta = self.srv.store.get_meta("sara")
        self.assertNotIn("assignment", meta["sourceData"])  # la configuración no se publica

        # Carga previa: Ana = 4 gestionados (2 con fecha del evento + 1 día) + Planner 15 (T1: 15/2, T5: 15/2) = 19;
        # Luis = 1 gestionado + Planner 7,5 (T1) = 8,5. Los 3 vuelos (5 eventos) van a Luis.
        people = meta["sourceData"]["workload"]["byPerson"]
        self.assertEqual(people["ana.perez@example.com"]["planner"]["pending"], 15)
        self.assertEqual(people["luis.gomez@example.com"]["planner"]["pending"], 7.5)
        self.assertEqual(people["ana.perez@example.com"]["saraDone"], 4)
        owners = {k: v["owner"] for k, v in meta["assignment"]["owners"].items()}
        self.assertEqual(owners, {"1001": "luis.gomez@example.com", "1002": "luis.gomez@example.com",
                                  "1004": "luis.gomez@example.com"})
        loads = {v["email"]: v["workload"] for v in meta["assignment"]["summary"]["validators"]}
        self.assertEqual(loads, {"ana.perez@example.com": 19, "luis.gomez@example.com": 13.5})
        owners_before = meta["assignment"]["owners"]

        # Sin cambios -> no se envía.
        self.assertIn("sin cambios", self.run_main("sara")[1])
        # --force: mismos datos -> los dueños se conservan (estado leído de Cloudflare).
        code, out = self.run_main("sara", "--force")
        self.assertIn("asignación: conservados 3, nuevos 0", out)
        self.assertEqual(
            {k: v["owner"] for k, v in self.srv.store.get_meta("sara")["assignment"]["owners"].items()},
            {k: v["owner"] for k, v in owners_before.items()},
        )
        # Un cambio en Planner (insumo de la asignación) también provoca el envío de Sara.
        with open(self.csv, "a", encoding="utf-8", newline="") as handle:
            handle.write("T9,Nueva,Ana Pérez,ana.perez@example.com,Seguimiento,No iniciada,Baja,2026-10-01 09:00,\r\n")
        code, out = self.run_main("sara")
        self.assertNotIn("sin cambios", out)
        self.assertEqual(self.srv.store.get_meta("sara")["sourceData"]["workload"]["byPerson"]
                         ["ana.perez@example.com"]["planner"]["pending"], 20)
        # Cambio en la lista de validadores -> se envía y se reasigna.
        self.add_sara_source(assignment={"validators": [{"email": "ana.perez@example.com"}]})
        code, out = self.run_main("sara")
        self.assertEqual(code, 0, out)
        owners = {o["owner"] for o in self.srv.store.get_meta("sara")["assignment"]["owners"].values()}
        self.assertEqual(owners, {"ana.perez@example.com"})
        log_text = (self.tmp / "logs" / "push_source.log").read_text(encoding="utf-8")
        self.assertNotIn(self.SECRET, log_text)

    @mock.patch("push_source.time.sleep")
    def test_http_error_hides_the_api_key(self, sleep):
        self.addCleanup(self.tearDownSara)
        self.add_sara_source(path="/__fixtures__/no-existe.csv")
        code, out = self.run_main("sara")
        self.assertEqual(code, 1)
        self.assertIn("HTTP 404", out)
        self.assertNotIn(self.SECRET, out)

    def test_http_source_without_key_is_config_error(self):
        self.addCleanup(self.tearDownSara)
        self.add_sara_source()
        os.environ.pop("SARA_TEST_KEY")
        code, out = self.run_main("sara")
        self.assertEqual(code, 2)
        self.assertIn("SARA_TEST_KEY", out)

    @mock.patch("push_source.time.sleep")
    def test_network_errors_are_retried_then_fail(self, sleep):
        os.environ["INGEST_URL"] = "http://127.0.0.1:9"  # puerto cerrado
        code, _ = self.run_main("planner")
        self.assertEqual(code, 1)
        self.assertEqual(sleep.call_count, 3)  # 4 intentos

    @mock.patch("push_source.time.sleep")
    def test_retry_on_503_then_success(self, sleep):
        def response(body):
            ok = mock.MagicMock()
            ok.__enter__.return_value.read.return_value = json.dumps(body).encode()
            return ok

        error = urllib.error.HTTPError("u", 503, "no", {}, io.BytesIO(b"ocupado"))
        part_ok = response({"length": 100, "received": 7, "invalidIndexes": []})
        commit_ok = response({"accepted": 7})
        with mock.patch("push_source.urllib.request.urlopen", side_effect=[error, part_ok, commit_ok]) as urlopen:
            code, _ = self.run_main("planner")
        self.assertEqual(code, 0)
        self.assertEqual(urlopen.call_count, 3)  # parte (falla + reintento) y publicación
        self.assertEqual(sleep.call_count, 1)
        part_request = urlopen.call_args_list[1].args[0]
        self.assertIn("/api/ingest/planner/parts?batch=", part_request.full_url)
        commit_request = urlopen.call_args_list[2].args[0]
        self.assertEqual(commit_request.get_header("X-api-key"), API_KEY)
        self.assertTrue(commit_request.full_url.endswith("/api/ingest/planner"))
        commit = json.loads(commit_request.data)
        self.assertEqual(commit["parts"], [{"index": 0, "length": 100, "received": 7, "invalidIndexes": []}])

    def test_split_parts(self):
        tasks = [{"uid": f"s:{i}", "pad": "x" * 100} for i in range(50)]
        bodies = push_source.split_parts(tasks, target_bytes=1000)
        self.assertGreater(len(bodies), 1)
        self.assertTrue(all(len(b) < 1300 for b in bodies))
        rebuilt = [t for b in bodies for t in json.loads(b)["tasks"]]
        self.assertEqual(rebuilt, tasks)
        self.assertEqual(push_source.split_parts([]), [b'{"tasks":[]}'])

    def test_failed_part_does_not_publish(self):
        """Si una parte falla, no se publica: el sitio sigue mostrando la versión anterior."""
        self.assertEqual(self.run_main("planner")[0], 0)
        before = self.srv.store.get_meta("planner")["updatedAt"]
        with mock.patch.object(push_source, "split_parts", return_value=[b'{"tasks":[]}', b"{no json"]):
            code, out = self.run_main("planner", "--force")
        self.assertEqual(code, 1)
        self.assertIn("HTTP 400", out)
        self.assertEqual(self.srv.store.get_meta("planner")["updatedAt"], before)


if __name__ == "__main__":
    unittest.main()
