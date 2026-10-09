import unittest
from datetime import datetime, timezone

import _path  # noqa: F401

from common.assignment import assign_flights, normalize_config
from common.workload import baseline_from_workload, planner_work, task_weight

WEIGHTS = {"Logged for Statistics (UR 1-10)": 5, "Assessment (UR 20-50)": 15, "FULL INVESTIGATION (UR 500-2500))": 45}
SINCE = datetime(2026, 10, 1, 12, 0, tzinfo=timezone.utc)
ANA = {"key": "ana@x.com", "name": "Ana", "email": "ana@x.com"}
LUIS = {"key": "luis@x.com", "name": "Luis", "email": "luis@x.com"}


def task(uid, labels, assignees, status="in_progress", closed_at=None):
    return {"uid": uid, "labels": labels, "assignees": assignees, "status": status, "closedAt": closed_at}


class TaskWeightTest(unittest.TestCase):
    def test_highest_weighted_label_wins_and_labels_are_normalized(self):
        self.assertEqual(task_weight(["MOR", "Logged for Statistics (UR 1-10)"], WEIGHTS), ("Logged for Statistics (UR 1-10)", 5))
        self.assertEqual(task_weight(["Logged for Statistics (UR 1-10)", "Assessment (UR 20-50)"], WEIGHTS),
                         ("Assessment (UR 20-50)", 15))
        self.assertEqual(task_weight(["  assessment   (ur 20-50) "], WEIGHTS), ("Assessment (UR 20-50)", 15))
        self.assertIsNone(task_weight(["MOR", "FEEDBACK P."], WEIGHTS))
        self.assertIsNone(task_weight([], WEIGHTS))


class PlannerWorkTest(unittest.TestCase):
    def test_pending_done_split_and_ignored_tasks(self):
        tasks = [
            task("A1", ["Assessment (UR 20-50)"], [ANA]),                                   # ana pendiente 15
            task("A2", ["MOR", "Logged for Statistics (UR 1-10)"], [ANA, LUIS]),            # 5 / 2 c/u
            task("A3", ["FULL INVESTIGATION (UR 500-2500))"], [LUIS], "completed", "2026-10-05T10:00:00-05:00"),  # luis hecho 45
            task("A4", ["Assessment (UR 20-50)"], [LUIS], "completed", "2026-09-01T10:00:00-05:00"),  # fuera de ventana
            task("A5", ["MOR"], [ANA]),                                                       # sin peso
            task("A6", ["Assessment (UR 20-50)"], []),                                        # sin responsable
        ]
        work = planner_work(tasks, WEIGHTS, SINCE)
        self.assertEqual(set(work), {"ana@x.com", "luis@x.com"})
        self.assertEqual((work["ana@x.com"]["pending"], work["ana@x.com"]["done"]), (17.5, 0))
        self.assertEqual((work["luis@x.com"]["pending"], work["luis@x.com"]["done"]), (2.5, 45))
        self.assertEqual(work["ana@x.com"]["byLabel"], {
            "Assessment (UR 20-50)": {"pending": 15, "done": 0, "tasks": 1},
            "Logged for Statistics (UR 1-10)": {"pending": 2.5, "done": 0, "tasks": 1},
        })

    def test_baseline_sums_sara_done_and_planner(self):
        workload = {"byPerson": {
            "ana@x.com": {"email": "ana@x.com", "saraDone": 4, "planner": {"pending": 15, "done": 2.5}},
            "sin-correo": {"email": None, "saraDone": 0, "planner": {"pending": 5, "done": 0}},
        }}
        self.assertEqual(baseline_from_workload(workload), {"ana@x.com": 21.5})
        self.assertEqual(baseline_from_workload(None), {})


class AssignmentWithBaselineTest(unittest.TestCase):
    CONFIG = normalize_config({"validators": [{"email": "a@x.com"}, {"email": "b@x.com"}]})

    @staticmethod
    def flight(fid, load):
        return {"sourceId": fid, "labels": [], "extra": {"openEvents": load, "olderOpenEvents": 0}}

    def test_who_worked_more_in_the_window_gets_less_new_work(self):
        result = assign_flights([self.flight("F1", 3), self.flight("F2", 3)], {}, self.CONFIG, "t", {"a@x.com": 10})
        self.assertEqual({k: v["owner"] for k, v in result["owners"].items()}, {"F1": "b@x.com", "F2": "b@x.com"})
        summary = {v["email"]: (v["baseline"], v["openEvents"], v["workload"]) for v in result["summary"]["validators"]}
        self.assertEqual(summary, {"a@x.com": (10, 0, 10), "b@x.com": (0, 6, 6)})

    def test_kept_flights_still_keep_their_owner(self):
        previous = {"F1": {"owner": "a@x.com", "since": "t0"}}
        result = assign_flights([self.flight("F1", 3)], previous, self.CONFIG, "t", {"a@x.com": 100})
        self.assertEqual(result["owners"]["F1"]["owner"], "a@x.com")


if __name__ == "__main__":
    unittest.main()
