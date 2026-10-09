import copy
import json
import unittest

import _path

from common.assignment import AssignmentConfigError, assign_flights, fnv1a32, normalize_config

CASES = json.loads((_path.FIXTURES / "assignment_cases.json").read_text(encoding="utf-8"))


def expand(task):
    return {
        "uid": f"sara:{task['id']}", "source": "sara", "sourceId": task["id"], "title": "", "assignees": [],
        "labels": task["labels"], "status": "pending", "priority": None, "createdAt": None, "closedAt": None,
        "extra": {"openEvents": task["load"], "olderOpenEvents": task.get("older", 0),
                  "registration": task.get("registration", "")},
    }


class SharedAssignmentCasesTest(unittest.TestCase):
    """Mismos casos que verifica el lado JS (functions/_lib/assignment.js)."""

    def test_hash(self):
        for text, expected in CASES["hash"]:
            with self.subTest(text=text):
                self.assertEqual(fnv1a32(text), expected)

    def test_config_errors(self):
        for case in CASES["configErrors"]:
            with self.subTest(config=case["config"]):
                with self.assertRaises(AssignmentConfigError) as ctx:
                    normalize_config(case["config"])
                self.assertEqual(str(ctx.exception), case["message"])

    def test_normalize_config(self):
        self.assertEqual(normalize_config(CASES["normalizeConfig"]["input"]), CASES["normalizeConfig"]["expected"])

    def test_cases(self):
        for case in CASES["cases"]:
            with self.subTest(case=case["name"]):
                tasks = [expand(t) for t in case["tasks"]]
                result = assign_flights(tasks, case["previous"], normalize_config(case["config"]), case["now"])
                expected = case["expected"]
                summary = result["summary"]
                self.assertEqual(result["owners"], expected["owners"])
                self.assertEqual(summary["conflicts"], expected["conflicts"])
                self.assertEqual(summary["backlog"], expected["backlog"])
                self.assertEqual(summary["counts"], expected["counts"])
                self.assertEqual(
                    {v["email"]: [v["flights"], v["openEvents"]] for v in summary["validators"]}, expected["validators"]
                )
                owners_by_task = {
                    t["id"]: (result["owners"][t["id"]]["owner"] if t["id"] in result["owners"] else None)
                    for t in case["tasks"]
                }
                self.assertEqual(owners_by_task, expected["assignees"])
                if "restrictedTypes" in expected:
                    self.assertEqual(
                        {v["email"]: v["restrictedTypes"] for v in summary["validators"]}, expected["restrictedTypes"]
                    )


class AssignmentBehaviourTest(unittest.TestCase):
    CONFIG = normalize_config({"validators": [{"email": "a@x.com", "name": "Ana"}, {"email": "b@x.com"}]})

    def test_input_not_mutated(self):
        tasks = [expand({"id": "F1", "labels": [], "load": 2, })]
        previous = {"F1": {"owner": "zzz@x.com", "since": "t0"}}
        original = copy.deepcopy((tasks, previous))
        result = assign_flights(tasks, previous, self.CONFIG, "now")
        self.assertEqual((tasks, previous), original)
        self.assertIn(result["owners"]["F1"]["owner"], ("a@x.com", "b@x.com"))

    def test_tie_break_does_not_depend_on_validator_order(self):
        tasks = [expand({"id": f"F{i}", "labels": [], "load": 1, }) for i in range(12)]
        forward = normalize_config({"validators": [{"email": "a@x.com"}, {"email": "b@x.com"}, {"email": "c@x.com"}]})
        backward = {**forward, "validators": list(reversed(forward["validators"]))}
        self.assertEqual(
            assign_flights(tasks, {}, forward, "t")["owners"], assign_flights(tasks, {}, backward, "t")["owners"]
        )

    def test_stable_when_new_flights_arrive(self):
        """Un vuelo con dueÃ±o no cambia aunque entre mucho trabajo nuevo."""
        tasks = [expand({"id": f"F{i}", "labels": [], "load": 1 + i % 3, }) for i in range(10)]
        first = assign_flights(tasks, {}, self.CONFIG, "t1")
        more = tasks + [expand({"id": f"N{i}", "labels": [], "load": 5, }) for i in range(4)]
        second = assign_flights(more, first["owners"], self.CONFIG, "t2")
        for fid, owner in first["owners"].items():
            self.assertEqual(second["owners"][fid], owner)
        self.assertEqual(second["summary"]["counts"]["kept"], 10)

    def test_deterministic(self):
        tasks = [expand({"id": f"F{i}", "labels": [], "load": 1 + i % 4, }) for i in range(30)]
        a = assign_flights(tasks, {}, self.CONFIG, "t")
        b = assign_flights(list(reversed(tasks)), {}, self.CONFIG, "t")
        self.assertEqual(a["owners"], b["owners"])

    def test_balanced_from_zero(self):
        tasks = [expand({"id": f"F{i:02d}", "labels": [], "load": 1 + i % 5, }) for i in range(40)]
        summary = assign_flights(tasks, {}, self.CONFIG, "t")["summary"]
        loads = [v["openEvents"] for v in summary["validators"]]
        self.assertLessEqual(max(loads) - min(loads), 5)  # diferencia acotada por el vuelo mÃ¡s grande


if __name__ == "__main__":
    unittest.main()
