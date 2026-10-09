import copy
import json
import unittest

import _path

from adapters import run_adapter
from common.csv_source import read_rows
from common.schema import (
    DEFAULT_MAX_INVALID_RATIO,
    is_valid_batch,
    is_valid_source_name,
    validate_commit,
    validate_payload,
    validate_task,
)

CASES = json.loads((_path.FIXTURES / "schema_cases.json").read_text(encoding="utf-8"))
SOURCE = CASES["source"]


def apply_patch(patch):
    task = copy.deepcopy(CASES["baseTask"])
    for key, value in patch.items():
        if value == "__delete__":
            task.pop(key, None)
        else:
            task[key] = value
    return task


def build_task(case):
    return case["task"] if "task" in case else apply_patch(case["patch"])


class SharedSchemaCasesTest(unittest.TestCase):
    """Mismos casos que verifica el lado JS (functions/_lib/schema.js)."""

    def test_source_names(self):
        for name in CASES["sourceNames"]["valid"]:
            with self.subTest(name=name):
                self.assertTrue(is_valid_source_name(name))
        for name in CASES["sourceNames"]["invalid"]:
            with self.subTest(name=name):
                self.assertFalse(is_valid_source_name(name))

    def test_batches(self):
        for batch in CASES["batches"]["valid"]:
            with self.subTest(batch=batch):
                self.assertTrue(is_valid_batch(batch))
        for batch in CASES["batches"]["invalid"]:
            with self.subTest(batch=batch):
                self.assertFalse(is_valid_batch(batch))

    def test_commit_cases(self):
        for case in CASES["commitCases"]:
            with self.subTest(case=case["name"]):
                result = validate_commit(copy.deepcopy(case["body"]), case.get("maxInvalidRatio", DEFAULT_MAX_INVALID_RATIO))
                expect = case["expect"]
                self.assertEqual(result["error"] is not None, expect["error"], result["error"])
                if not expect["error"]:
                    self.assertEqual(
                        (result["rejected"], result["received"], result["invalidCount"]),
                        (expect["rejected"], expect["received"], expect["invalidCount"]),
                    )

    def test_task_cases(self):
        for case in CASES["taskCases"]:
            with self.subTest(case=case["name"]):
                errors = validate_task(build_task(case), SOURCE)
                self.assertEqual(sorted(e["field"] for e in errors), case["fields"])

    def test_payload_cases(self):
        for case in CASES["payloadCases"]:
            with self.subTest(case=case["name"]):
                body = copy.deepcopy(case["body"])
                if case.get("tasksArePatches"):
                    body["tasks"] = [apply_patch(p) for p in body["tasks"]]
                ratio = case.get("maxInvalidRatio", DEFAULT_MAX_INVALID_RATIO)
                result = validate_payload(body, SOURCE, ratio)
                expect = case["expect"]
                self.assertEqual(result["error"] is not None, expect["error"])
                if expect["error"]:
                    continue
                self.assertEqual(result["rejected"], expect["rejected"])
                self.assertEqual(len(result["tasks"]), expect["valid"])
                self.assertEqual(len(result["invalid"]), expect["invalid"])
                if "invalidFields" in expect:
                    fields = [sorted(e["field"] for e in item["errors"]) for item in result["invalid"]]
                    self.assertEqual(fields, expect["invalidFields"])


class AdapterOutputIsValidTest(unittest.TestCase):
    """Lo que produce el adaptador de planner debe pasar la validación de la Function."""

    def test_planner_fixture_validates(self):
        columns, rows = read_rows(_path.FIXTURES / "planner_sample.csv")
        result = run_adapter("planner", columns, rows, "planner")
        check = validate_payload({"tasks": result.tasks, "warnings": result.warnings}, "planner")
        self.assertIsNone(check["error"])
        self.assertEqual(check["invalid"], [])
        self.assertEqual(len(check["tasks"]), len(result.tasks))


if __name__ == "__main__":
    unittest.main()
