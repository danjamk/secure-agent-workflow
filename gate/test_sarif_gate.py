"""Tests for sarif_gate.py. Run: python3 -m unittest discover -s gate"""

import contextlib
import json
import os
import shutil
import tempfile
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

    def test_no_results_passes(self):
        self.assertEqual(self.ids(sarif([], [])), [])

    def test_suppressed_finding_still_blocks(self):
        suppressed = result("js/sql-injection")
        suppressed["suppressions"] = [{"kind": "inSource"}]
        doc = sarif([suppressed], [rule("js/sql-injection", "8.8")])
        found = list(sarif_gate.blocking(doc, 7.0))
        self.assertEqual(found[0][0], "js/sql-injection")
        self.assertIn("suppressed in source", found[0][1])


def codeql_run(results=(), rules=(), successful=True):
    return {"tool": {"driver": {"name": "CodeQL", "rules": list(rules)}},
            "invocations": [{"executionSuccessful": successful}], "results": list(results)}


class MainTest(unittest.TestCase):
    """main() against SARIF directories on disk (#61: missing output fails)."""

    def setUp(self):
        self.dir = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, self.dir)

    def write(self, name, content):
        with open(os.path.join(self.dir, name), "w") as f:
            f.write(content if isinstance(content, str) else json.dumps(content))

    def run_main(self, *argv):
        with open(os.devnull, "w") as devnull, contextlib.redirect_stdout(devnull), \
                contextlib.redirect_stderr(devnull):
            return sarif_gate.main(list(argv))

    def test_clean_scan_passes(self):
        self.write("python.sarif", {"runs": [codeql_run()]})
        self.assertEqual(self.run_main(self.dir, "--languages", "python"), 0)

    def test_finding_fails(self):
        self.write("python.sarif", {"runs": [codeql_run(
            [result("py/sql-injection")], [rule("py/sql-injection", "8.8")])]})
        self.assertEqual(self.run_main(self.dir, "--languages", "python"), 1)

    def test_no_languages_passes_without_a_directory(self):
        self.assertEqual(self.run_main("/nonexistent", "--languages", ""), 0)

    def test_missing_directory_fails(self):
        self.assertEqual(self.run_main("/nonexistent", "--languages", "python"), 1)

    def test_empty_directory_fails(self):
        self.assertEqual(self.run_main(self.dir, "--languages", "python"), 1)

    def test_fewer_files_than_languages_fails(self):
        self.write("python.sarif", {"runs": [codeql_run()]})
        self.assertEqual(self.run_main(self.dir, "--languages", "python,actions"), 1)

    def test_empty_object_fails(self):
        self.write("python.sarif", {})
        self.assertEqual(self.run_main(self.dir, "--languages", "python"), 1)

    def test_no_runs_fails(self):
        self.write("python.sarif", {"runs": []})
        self.assertEqual(self.run_main(self.dir, "--languages", "python"), 1)

    def test_malformed_json_fails(self):
        self.write("python.sarif", '{"runs": [')
        self.assertEqual(self.run_main(self.dir, "--languages", "python"), 1)

    def test_run_without_a_tool_fails(self):
        self.write("python.sarif", {"runs": [{"results": []}]})
        self.assertEqual(self.run_main(self.dir, "--languages", "python"), 1)

    def test_failed_run_fails(self):
        self.write("python.sarif", {"runs": [codeql_run(successful=False)]})
        self.assertEqual(self.run_main(self.dir, "--languages", "python"), 1)

    def test_languages_argument_is_required(self):
        self.write("python.sarif", {"runs": [codeql_run()]})
        self.assertEqual(self.run_main(self.dir), 1)


if __name__ == "__main__":
    unittest.main()
