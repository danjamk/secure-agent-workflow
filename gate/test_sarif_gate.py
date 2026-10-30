"""Tests for sarif_gate.py. Run: python3 -m unittest discover -s gate"""

import unittest

import sarif_gate


def sarif(results, rules):
    return {"runs": [{"tool": {"driver": {"rules": rules}}, "results": results}]}


def rule(rule_id, severity=None, level=None):
    r = {"id": rule_id, "properties": {}}
    if severity is not None:
        r["properties"]["security-severity"] = severity
    if level is not None:
        r["defaultConfiguration"] = {"level": level}
    return r


def result(rule_id, level=None):
    r = {"ruleId": rule_id, "locations": [{"physicalLocation": {
        "artifactLocation": {"uri": "src/app.js"}, "region": {"startLine": 3}}}]}
    if level:
        r["level"] = level
    return r


class BlockingTest(unittest.TestCase):
    def ids(self, doc, threshold=7.0):
        return [f[0] for f in sarif_gate.blocking(doc, threshold)]

    def test_high_security_severity_blocks(self):
        doc = sarif([result("js/sql-injection")], [rule("js/sql-injection", "8.8")])
        self.assertEqual(self.ids(doc), ["js/sql-injection"])

    def test_medium_security_severity_passes(self):
        doc = sarif([result("js/weak")], [rule("js/weak", "5.0", "error")])
        self.assertEqual(self.ids(doc), [])

    def test_error_level_without_security_severity_blocks(self):
        doc = sarif([result("js/bug")], [rule("js/bug", level="error")])
        self.assertEqual(self.ids(doc), ["js/bug"])

    def test_result_level_overrides_rule_default(self):
        doc = sarif([result("js/bug", level="warning")], [rule("js/bug", level="error")])
        self.assertEqual(self.ids(doc), [])

    def test_warning_without_security_severity_passes(self):
        doc = sarif([result("js/style")], [rule("js/style", level="warning")])
        self.assertEqual(self.ids(doc), [])

    def test_threshold_is_configurable(self):
        doc = sarif([result("js/weak")], [rule("js/weak", "5.0")])
        self.assertEqual(self.ids(doc, threshold=4.0), ["js/weak"])

    def test_location_is_reported(self):
        doc = sarif([result("js/sql-injection")], [rule("js/sql-injection", "9.1")])
        self.assertEqual(list(sarif_gate.blocking(doc, 7.0))[0][2], "src/app.js:3")

    def test_empty_sarif_passes(self):
        self.assertEqual(self.ids({"runs": []}), [])


if __name__ == "__main__":
    unittest.main()
