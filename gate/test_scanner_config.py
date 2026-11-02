"""Tests for scanner_config.py. Run: python3 -m unittest discover -s gate"""

import base64
import contextlib
import os
import shutil
import tempfile
import unittest

import scanner_config

GITLEAKS_TOML = b'[extend]\nuseDefault = true\n'


class StubAPI:
    """The two API calls base_files makes, served from a dict of base files."""

    def __init__(self, files, truncated=False, modes=None):
        self.files, self.truncated, self.modes = files, truncated, modes or {}
        self.shas = {f"{i:040x}": p for i, p in enumerate(files)}

    def __call__(self, path):
        if "/git/trees/" in path:
            return {"truncated": self.truncated, "tree": [
                {"path": p, "type": "blob", "sha": sha, "mode": self.modes.get(p, "100644")}
                for sha, p in self.shas.items()] + [
                {"path": "src", "type": "tree", "sha": "t", "mode": "040000"}]}
        sha = path.rsplit("/", 1)[-1]
        return {"content": base64.b64encode(self.files[self.shas[sha]]).decode()}


class ScannerConfigTest(unittest.TestCase):
    def setUp(self):
        self.root = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, self.root)
        os.makedirs(os.path.join(self.root, ".git"))
        os.makedirs(os.path.join(self.root, "src"))
        self.saved = scanner_config.request
        self.addCleanup(setattr, scanner_config, "request", self.saved)
        os.environ.update({"REPO": "danjamk/agent-testbed", "BASE_SHA": "b" * 40})

    def write(self, path, content=b"x"):
        full = os.path.join(self.root, path)
        os.makedirs(os.path.dirname(full), exist_ok=True)
        with open(full, "wb") as f:
            f.write(content)

    def read(self, path):
        with open(os.path.join(self.root, path), "rb") as f:
            return f.read()

    def exists(self, path):
        return os.path.lexists(os.path.join(self.root, path))

    def run_main(self, api):
        scanner_config.request = api
        with open(os.devnull, "w") as devnull, contextlib.redirect_stdout(devnull):
            return scanner_config.main([self.root])

    def test_pr_ignore_files_are_removed_when_base_has_none(self):
        self.write(".gitleaksignore", b"abc:src/app.py:generic-api-key:3\n")
        self.write("sub/.semgrepignore", b"src/\n")
        self.write("api/osv-scanner.toml", b"[[IgnoredVulns]]\nid = 'GHSA-x'\n")
        self.write(".git/.gitleaksignore")  # never touched
        self.assertEqual(self.run_main(StubAPI({})), 0)
        self.assertFalse(self.exists(".gitleaksignore"))
        self.assertFalse(self.exists("sub/.semgrepignore"))
        self.assertFalse(self.exists("api/osv-scanner.toml"))
        self.assertTrue(self.exists(".git/.gitleaksignore"))

    def test_pr_edits_are_replaced_with_the_base_copy(self):
        self.write(".gitleaksignore", b"base-entry\npr-entry\n")
        self.assertEqual(self.run_main(StubAPI({".gitleaksignore": b"base-entry\n"})), 0)
        self.assertEqual(self.read(".gitleaksignore"), b"base-entry\n")

    def test_base_copy_is_restored_when_the_pr_deletes_it(self):
        self.assertEqual(self.run_main(StubAPI({"api/.trivyignore": b"CVE-1\n"})), 0)
        self.assertEqual(self.read("api/.trivyignore"), b"CVE-1\n")

    def test_any_gitleaks_config_format_is_replaced(self):
        # gitleaks finds .gitleaks.<ext> through viper once .gitleaks.toml exists.
        self.write(".gitleaks.json", b'{"allowlist": {"paths": [".*"]}}')
        self.assertEqual(self.run_main(StubAPI({".gitleaks.toml": GITLEAKS_TOML})), 0)
        self.assertFalse(self.exists(".gitleaks.json"))
        self.assertEqual(self.read(".gitleaks.toml"), GITLEAKS_TOML)

    def test_pr_symlink_is_removed_not_followed(self):
        outside = tempfile.NamedTemporaryFile(delete=False)
        self.addCleanup(os.remove, outside.name)
        os.symlink(outside.name, os.path.join(self.root, ".semgrepignore"))
        self.assertEqual(self.run_main(StubAPI({".semgrepignore": b"base\n"})), 0)
        self.assertFalse(os.path.islink(os.path.join(self.root, ".semgrepignore")))
        self.assertEqual(os.path.getsize(outside.name), 0)

    def test_write_through_a_planted_directory_link_is_refused(self):
        outside = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, outside)
        os.symlink(outside, os.path.join(self.root, "api"))
        self.assertEqual(self.run_main(StubAPI({"api/.trivyignore": b"CVE-1\n"})), 1)
        self.assertEqual(os.listdir(outside), [])

    def test_gitleaks_extend_path_is_refused(self):
        config = b'[extend]\npath = "config/rules.toml"\n'
        self.assertEqual(self.run_main(StubAPI({".gitleaks.toml": config})), 1)

    def test_unparseable_gitleaks_config_is_refused(self):
        self.assertEqual(self.run_main(StubAPI({".gitleaks.toml": b"[extend\n"})), 1)

    def test_truncated_tree_fails(self):
        self.assertEqual(self.run_main(StubAPI({}, truncated=True)), 1)

    def test_base_symlink_fails(self):
        api = StubAPI({".semgrepignore": b"target"}, modes={".semgrepignore": "120000"})
        self.assertEqual(self.run_main(api), 1)

    def test_api_error_fails(self):
        def broken(path):
            raise OSError("connection reset")
        self.assertEqual(self.run_main(broken), 1)

    def test_other_files_are_untouched(self):
        self.write("src/app.py", b"print(1)\n")
        self.write("docs/gitleaks.md", b"notes\n")
        self.assertEqual(self.run_main(StubAPI({})), 0)
        self.assertEqual(self.read("src/app.py"), b"print(1)\n")
        self.assertTrue(self.exists("docs/gitleaks.md"))


if __name__ == "__main__":
    unittest.main()
