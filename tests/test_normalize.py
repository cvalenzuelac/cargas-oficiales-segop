import json
import unittest

import _path

from common.normalize import normalize_email, normalize_name, split_labels, split_list, to_iso_bogota


class SharedNormalizeNameTest(unittest.TestCase):
    """Mismos casos que verifica public/js/lib/normalize.js (tests/js/)."""

    def test_shared_cases(self):
        cases = json.loads((_path.FIXTURES / "merge_cases.json").read_text(encoding="utf-8"))["normalizeName"]
        for raw, expected in cases:
            with self.subTest(raw=raw):
                self.assertEqual(normalize_name(raw), expected)


class NormalizeNameTest(unittest.TestCase):
    def test_removes_accents_lowercases_and_collapses_spaces(self):
        self.assertEqual(normalize_name("  José   NÚÑEZ "), "jose nunez")
        self.assertEqual(normalize_name("María\tLópez"), "maria lopez")
        self.assertEqual(normalize_name("Ñandú Ü"), "nandu u")

    def test_empty(self):
        self.assertEqual(normalize_name(""), "")
        self.assertEqual(normalize_name(None), "")
        self.assertEqual(normalize_name("   "), "")


class NormalizeEmailTest(unittest.TestCase):
    def test_lowercase_and_strip(self):
        self.assertEqual(normalize_email("  Luis.Gomez@Example.COM "), "luis.gomez@example.com")

    def test_empty_is_none(self):
        self.assertIsNone(normalize_email(""))
        self.assertIsNone(normalize_email("  "))
        self.assertIsNone(normalize_email(None))


class SplitTest(unittest.TestCase):
    def test_split_list_keeps_positions(self):
        self.assertEqual(split_list("Ana; ; Luis"), ["Ana", "", "Luis"])
        self.assertEqual(split_list("Ana"), ["Ana"])

    def test_split_list_empty_field(self):
        self.assertEqual(split_list(""), [])
        self.assertEqual(split_list("  "), [])
        self.assertEqual(split_list(None), [])

    def test_split_labels_drops_empty_and_duplicates(self):
        self.assertEqual(split_labels("Auditoría; ; Auditoría; Otra"), ["Auditoría", "Otra"])
        self.assertEqual(split_labels(""), [])


class IsoDateTest(unittest.TestCase):
    def test_converts_to_bogota_offset(self):
        self.assertEqual(to_iso_bogota("2026-09-01 08:30"), "2026-09-01T08:30:00-05:00")
        self.assertEqual(to_iso_bogota(" 2026-12-31 23:59 "), "2026-12-31T23:59:00-05:00")

    def test_accepts_seconds(self):
        self.assertEqual(to_iso_bogota("2026-09-01 08:30:15"), "2026-09-01T08:30:15-05:00")

    def test_empty_is_none(self):
        self.assertIsNone(to_iso_bogota(""))
        self.assertIsNone(to_iso_bogota(None))

    def test_invalid_raises(self):
        for value in ("2026/09/01 08:30", "2026-02-30 08:00", "01-09-2026 08:30", "ayer"):
            with self.subTest(value=value), self.assertRaises(ValueError):
                to_iso_bogota(value)


if __name__ == "__main__":
    unittest.main()
