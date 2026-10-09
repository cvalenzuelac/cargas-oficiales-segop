import unittest
from datetime import datetime, timezone

import _path

from adapters import AdapterError, run_adapter
from common.csv_source import parse_rows
from common.schema import validate_payload

NOW = datetime(2026, 10, 8, 12, 0, tzinfo=timezone.utc)
ROSTER = {"validators": [{"email": "Ana.Perez@example.com"}, {"email": "luis.gomez@example.com", "capacity": 0.5}]}
WEIGHTS = {"Logged for Statistics (UR 1-10)": 5, "Assessment (UR 20-50)": 15}
ANA = {"key": "ana.perez@example.com", "name": "Ana Pérez", "email": "ana.perez@example.com"}
MARIA = {"key": "maria@example.com", "name": "María", "email": "maria@example.com"}


def load(repair="eventname"):
    info = {}
    columns, rows = parse_rows((_path.FIXTURES / "sara_sample.csv").read_bytes(), ",", repair, info)
    return columns, rows, info


def adapt(options=None):
    columns, rows, _ = load()
    return run_adapter("sara", columns, rows, "sara", {"now": NOW, "assignment": ROSTER, **(options or {})})


class CsvRepairTest(unittest.TestCase):
    def test_unquoted_comma_is_repaired_into_eventname_case_insensitive(self):
        columns, rows, info = load()
        self.assertEqual(columns[7], "eventName")  # el encabezado trae mayúsculas
        self.assertEqual(info, {"repaired": 1, "dropped": 0})
        row = next(r for r in rows if r["eventId"] == "9002")
        self.assertEqual(row["eventName"], "2002 - SPEED HIGH, BELOW 1000 FT")
        self.assertEqual((row["isopen"], row["severity"], row["ModificationDate"]), ("True", "3", ""))

    def test_without_repair_the_row_is_shifted(self):
        _, rows, info = load(repair=None)
        self.assertEqual(info["dropped"], 1)
        row = next(r for r in rows if r["eventId"] == "9002")
        self.assertEqual(row["isopen"], "False")  # por eso hace falta reparar


class SaraAdapterTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.result = adapt()
        cls.tasks = {t["sourceId"]: t for t in cls.result.tasks}

    def test_one_task_per_flight_with_open_events(self):
        self.assertEqual(list(self.tasks), ["1001", "1002", "1004"])
        for task in self.result.tasks:
            self.assertEqual(task["assignees"], [])
            self.assertEqual(task["status"], "pending")
            self.assertEqual(task["uid"], f"sara:{task['sourceId']}")

    def test_flight_details(self):
        f = self.tasks["1001"]
        self.assertEqual(f["title"], "N123AV SKBO–SKRG")
        self.assertEqual(f["labels"], ["1001 - HARD LANDING", "2002 - SPEED HIGH, BELOW 1000 FT"])
        self.assertEqual(f["createdAt"], "2026-10-01T09:59:00Z")
        self.assertEqual(f["extra"], {
            "registration": "N123AV", "origin": "SKBO", "destination": "SKRG",
            "takeoffAt": "2026-10-01T09:30:00Z", "openEvents": 3, "olderOpenEvents": 0,
            "lastEventAt": "2026-10-01T10:05:00Z",
        })

    def test_events_older_than_window_are_not_open_events(self):
        # 1002 solo tiene un evento isopen de enero: no es carga, queda como rezagado.
        extra = self.tasks["1002"]["extra"]
        self.assertEqual((extra["openEvents"], extra["olderOpenEvents"]), (0, 1))
        self.assertEqual(self.tasks["1002"]["createdAt"], "2026-01-15T08:00:00Z")

    def test_missing_eventdate_falls_back_to_takeoff(self):
        f = self.tasks["1004"]
        self.assertEqual((f["createdAt"], f["extra"]["openEvents"]), ("2026-10-02T11:00:00Z", 1))

    def test_summary_warnings(self):
        codes = sorted(w["code"] for w in self.result.warnings)
        self.assertEqual(codes, ["duplicate_event", "invalid_flag"])
        self.assertTrue(all(w["sourceId"] is None for w in self.result.warnings))

    def test_work_done_uses_modification_date_in_7_days(self):
        workload = self.result.source_data["workload"]
        self.assertEqual((workload["windowDays"], workload["from"], workload["to"], workload["basis"]),
                         (7, "2026-10-01T12:00:00Z", "2026-10-08T12:00:00Z", "modificationdate"))
        # Ana: 9004 y 9005 modificados en la ventana (9005 invalidado); 9012 sin ModificationDate,
        # evento del 2-oct + 1 día = dentro; 9013 sin ModificationDate, 30-sep 05:00 + 1 día = fuera.
        # Luis: 9006 modificado el 1-sep, fuera de la ventana. "SARA" sin @; otra persona fuera de la lista.
        ana = workload["byPerson"]["ana.perez@example.com"]
        luis = workload["byPerson"]["luis.gomez@example.com"]
        self.assertEqual((ana["saraDone"], ana["saraInvalidated"]), (3, 1))
        self.assertEqual((luis["saraDone"], luis["saraInvalidated"]), (0, 0))
        self.assertEqual(set(workload["byPerson"]), {"ana.perez@example.com", "luis.gomez@example.com"})

    def test_window_and_assignment_config_travel_in_source_data(self):
        data = self.result.source_data
        self.assertEqual(data["window"], {"days": 180, "from": "2026-04-11T12:00:00Z"})
        self.assertEqual([v["email"] for v in data["assignment"]["validators"]],
                         ["ana.perez@example.com", "luis.gomez@example.com"])

    def test_custom_windows(self):
        result = adapt({"windowDays": 300, "workWindowDays": 60})
        tasks = {t["sourceId"]: t for t in result.tasks}
        self.assertEqual((tasks["1002"]["extra"]["openEvents"], tasks["1002"]["extra"]["olderOpenEvents"]), (1, 0))
        self.assertEqual(result.source_data["workload"]["byPerson"]["luis.gomez@example.com"]["saraDone"], 1)

    def test_planner_tasks_enter_the_workload(self):
        planner = [
            {"uid": "planner:1", "labels": ["Assessment (UR 20-50)"], "status": "in_progress", "closedAt": None,
             "assignees": [ANA]},
            {"uid": "planner:2", "labels": ["Logged for Statistics (UR 1-10)"], "status": "completed",
             "closedAt": "2026-10-07T09:00:00-05:00", "assignees": [ANA, MARIA]},
        ]
        result = adapt({"plannerTasks": planner, "plannerWeights": WEIGHTS})
        people = result.source_data["workload"]["byPerson"]
        self.assertEqual(people["ana.perez@example.com"]["planner"]["pending"], 15)
        self.assertEqual(people["ana.perez@example.com"]["planner"]["done"], 2.5)
        self.assertEqual(people["ana.perez@example.com"]["saraDone"], 3)
        # María no valida, pero tiene carga de Planner: aparece igual.
        self.assertEqual(people["maria@example.com"]["planner"]["done"], 2.5)
        self.assertEqual(result.source_data["workload"]["weights"], WEIGHTS)

    def test_team_list_travels_normalized(self):
        result = adapt({"team": [" Ana.Perez@example.com", "luis.gomez@example.com", "ana.perez@example.com"]})
        self.assertEqual(result.source_data["team"], ["ana.perez@example.com", "luis.gomez@example.com"])
        self.assertNotIn("team", self.result.source_data)
        with self.assertRaisesRegex(AdapterError, "options.team"):
            adapt({"team": ["sin-arroba"]})

    def test_planner_tasks_without_weights_is_an_error(self):
        with self.assertRaisesRegex(AdapterError, "plannerWeights"):
            adapt({"plannerTasks": []})

    def test_payload_is_valid_for_the_function(self):
        check = validate_payload(
            {"tasks": self.result.tasks, "warnings": self.result.warnings, "sourceData": self.result.source_data}, "sara"
        )
        self.assertIsNone(check["error"])
        self.assertEqual(check["invalid"], [])

    def test_invalid_assignment_config_aborts(self):
        columns, rows, _ = load()
        with self.assertRaisesRegex(AdapterError, "capacity"):
            run_adapter("sara", columns, rows, "sara",
                        {"now": NOW, "assignment": {"validators": [{"email": "a@x.com", "capacity": -1}]}})

    def test_without_assignment_config(self):
        columns, rows, _ = load()
        result = run_adapter("sara", columns, rows, "sara", {"now": NOW})
        self.assertNotIn("assignment", result.source_data)
        self.assertEqual(result.source_data["workload"]["byPerson"], {})

    def test_missing_column_aborts(self):
        columns, rows, _ = load()
        with self.assertRaisesRegex(AdapterError, "modificationdate"):
            run_adapter("sara", [c for c in columns if c != "ModificationDate"], rows, "sara", {"now": NOW})


if __name__ == "__main__":
    unittest.main()
