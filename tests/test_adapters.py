import unittest

import _path

from adapters import REGISTRY, AdapterError, run_adapter
from adapters import template
from common.csv_source import read_rows

TASK_KEYS = {
    "uid", "source", "sourceId", "title", "assignees", "labels",
    "status", "priority", "createdAt", "closedAt", "extra",
}


def codes_for(warnings, source_id):
    return sorted(w["code"] for w in warnings if w["sourceId"] == source_id)


class PlannerAdapterTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        columns, rows = read_rows(_path.FIXTURES / "planner_sample.csv")
        cls.result = run_adapter("planner", columns, rows, "planner")
        cls.tasks = {t["sourceId"]: t for t in cls.result.tasks}

    def test_reads_bom_and_skips_duplicate_and_missing_ids(self):
        self.assertEqual(list(self.tasks), ["T1", "T2", "T3", "T4", "T5", "T6", "T7"])
        self.assertEqual(codes_for(self.result.warnings, "T2"), ["duplicate_id"])
        self.assertEqual(codes_for(self.result.warnings, None), ["missing_id"])
        self.assertEqual(self.tasks["T2"]["title"], "Informe mensual")

    def test_task_shape(self):
        for task in self.result.tasks:
            with self.subTest(task=task["uid"]):
                self.assertEqual(set(task), TASK_KEYS)
                self.assertEqual(task["uid"], f"planner:{task['sourceId']}")
                self.assertEqual(task["source"], "planner")
                self.assertEqual(task["extra"], {})
                for person in task["assignees"]:
                    self.assertEqual(set(person), {"key", "name", "email"})

    def test_complete_row(self):
        t1 = self.tasks["T1"]
        self.assertEqual(t1["title"], "Revisar manual, capítulo 3")
        self.assertEqual(
            t1["assignees"],
            [
                {"key": "ana.perez@example.com", "name": "Ana Pérez", "email": "ana.perez@example.com"},
                {"key": "luis.gomez@example.com", "name": "Luis Gómez", "email": "luis.gomez@example.com"},
            ],
        )
        self.assertEqual(t1["labels"], ["Auditoría", "Seguimiento"])
        self.assertEqual(t1["status"], "in_progress")
        self.assertEqual(t1["priority"], "urgent")
        self.assertEqual(t1["createdAt"], "2026-09-01T08:30:00-05:00")
        self.assertIsNone(t1["closedAt"])
        self.assertEqual(codes_for(self.result.warnings, "T1"), [])

    def test_closed_task(self):
        t2 = self.tasks["T2"]
        self.assertEqual(t2["status"], "completed")
        self.assertEqual(t2["priority"], "medium")
        self.assertEqual(t2["closedAt"], "2026-09-10T17:45:00-05:00")

    def test_no_assignees(self):
        t3 = self.tasks["T3"]
        self.assertEqual(t3["assignees"], [])
        self.assertEqual(t3["labels"], [])
        self.assertEqual(t3["status"], "not_started")
        self.assertEqual(t3["priority"], "low")
        self.assertEqual(codes_for(self.result.warnings, "T3"), [])

    def test_mismatched_names_and_emails_fall_back_to_name_key(self):
        t4 = self.tasks["T4"]
        self.assertEqual(
            t4["assignees"],
            [
                {"key": "ana perez", "name": "Ana Pérez", "email": None},
                {"key": "luis gomez", "name": "Luis Gómez", "email": None},
            ],
        )
        self.assertEqual(t4["priority"], "important")
        self.assertEqual(codes_for(self.result.warnings, "T4"), ["assignee_email_mismatch"])

    def test_empty_email_falls_back_to_name_key(self):
        t5 = self.tasks["T5"]
        self.assertEqual(
            t5["assignees"],
            [
                {"key": "maria lopez", "name": "María López", "email": None},
                {"key": "ana.perez@example.com", "name": "Ana Pérez", "email": "ana.perez@example.com"},
            ],
        )
        self.assertEqual(t5["labels"], ["Auditoría"])
        self.assertEqual(codes_for(self.result.warnings, "T5"), ["assignee_email_missing"])

    def test_unknown_values_warn(self):
        t6 = self.tasks["T6"]
        self.assertEqual(t6["status"], "Bloqueada")
        self.assertIsNone(t6["priority"])
        self.assertIsNone(t6["createdAt"])
        self.assertEqual(
            codes_for(self.result.warnings, "T6"),
            ["invalid_date", "unknown_priority", "unknown_status"],
        )

    def test_power_automate_display_name_objects(self):
        """Power Automate puede escribir '{"displayName":"Ana Pérez"}' en vez del nombre."""
        self.assertEqual(
            self.tasks["T7"]["assignees"],
            [
                {"key": "ana.perez@example.com", "name": "Ana Pérez", "email": "ana.perez@example.com"},
                {"key": "luis.gomez@example.com", "name": "Luis Gómez", "email": "luis.gomez@example.com"},
            ],
        )
        self.assertEqual(codes_for(self.result.warnings, "T7"), [])

    def test_display_name_helper(self):
        from adapters.planner import display_name

        self.assertEqual(display_name('{"displayName":" Ana "}'), "Ana")
        self.assertEqual(display_name('{"name":"Ana"}'), "Ana")
        self.assertEqual(display_name("Ana Pérez"), "Ana Pérez")
        self.assertEqual(display_name("{no es json}"), "{no es json}")

    def test_missing_column_aborts(self):
        columns, rows = read_rows(_path.FIXTURES / "planner_sample.csv")
        columns = [c for c in columns if c != "Correos"]
        with self.assertRaisesRegex(AdapterError, "Correos"):
            run_adapter("planner", columns, rows, "planner")


class RegistryTest(unittest.TestCase):
    def test_unknown_adapter(self):
        with self.assertRaises(AdapterError):
            run_adapter("no-existe", [], [], "x")

    def test_template_is_not_registered(self):
        self.assertNotIn("template", REGISTRY)
        for module in REGISTRY.values():
            self.assertNotIn("template", module)


class TemplateAdapterTest(unittest.TestCase):
    """La plantilla debe funcionar tal cual para servir de punto de partida."""

    def test_template_produces_valid_tasks(self):
        rows = [{"ID": "A1", "Titulo": "Algo", "Responsable": "José Núñez", "Estado": "x",
                 "FechaCreacion": "2026-09-01 08:00", "FechaCierre": ""}]
        result = template.adapt(rows, "fuente2")
        self.assertEqual(len(result.tasks), 1)
        task = result.tasks[0]
        self.assertEqual(set(task), TASK_KEYS)
        self.assertEqual(task["uid"], "fuente2:A1")
        self.assertEqual(task["assignees"], [{"key": "jose nunez", "name": "José Núñez", "email": None}])
        self.assertIsNone(task["priority"])
        self.assertEqual([w["code"] for w in result.warnings], ["unknown_status"])


if __name__ == "__main__":
    unittest.main()
