"""Tests for prepare.py. Run: python3 -m unittest discover -s deploy/cloudflare"""

import contextlib
import hashlib
import io
import json
import os
import tarfile
import tempfile
import unittest

import prepare

SHA = "0123456789abcdef0123456789abcdef01234567"
TOML = """name = "app"
main = "src/index.ts"
compatibility_date = "2026-10-01"
account_id = "factory"

[build]
command = "npm run build"

[env.preview]
[env.staging]
vars = { MODE = "staging" }
"""


def make_bundle(path, files, links=()):
    """files: {name: bytes}; links: [(name, target)]"""
    with tarfile.open(path, "w:gz") as tar:
        for name, data in files.items():
            info = tarfile.TarInfo(name)
            info.size = len(data)
            tar.addfile(info, io.BytesIO(data))
        for name, target in links:
            info = tarfile.TarInfo(name)
            info.type = tarfile.SYMTYPE
            info.linkname = target
            tar.addfile(info)
    with open(path, "rb") as f:
        return hashlib.sha256(f.read()).hexdigest()


class Prepare(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.dir = self.tmp.name
        self.bundle = os.path.join(self.dir, "bundle.tgz")
        self.out = os.path.join(self.dir, "out")

    def tearDown(self):
        self.tmp.cleanup()

    def run_prepare(self, files, links=(), config="wrangler.toml", env="preview", digest=None):
        d = make_bundle(self.bundle, files, links)
        with contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
            return prepare.main(["--bundle", self.bundle, "--digest", digest or d, "--config", config,
                                 "--env", env, "--sha", SHA, "--out", self.out])

    def good(self, **extra):
        files = {"dist/index.js": b"export default {}", "wrangler.toml": TOML.encode()}
        files.update(extra)
        return files

    def test_good_bundle(self):
        files = self.good(**{"package.json": b'{"version": "1.2.3"}'})
        self.assertEqual(self.run_prepare(files), 0)
        with open(os.path.join(self.out, "wrangler.json")) as f:
            cfg = json.load(f)
        self.assertNotIn("build", cfg)
        self.assertNotIn("account_id", cfg)
        self.assertFalse(os.path.exists(os.path.join(self.out, "wrangler.toml")))
        self.assertEqual(cfg["main"], "dist/index.js")
        self.assertEqual(cfg["env"]["staging"]["vars"], {"MODE": "staging"})
        with open(os.path.join(self.out, "build-id")) as f:
            self.assertEqual(f.read(), "1.2.3+0123456")

    def test_digest_mismatch(self):
        self.assertEqual(self.run_prepare(self.good(), digest="0" * 64), 1)

    def test_symlink_refused(self):
        files = {"wrangler.toml": TOML.encode()}
        self.assertEqual(self.run_prepare(files, links=[("dist/index.js", "/home/runner/work/_temp/env")]), 1)
        self.assertFalse(os.path.lexists(os.path.join(self.out, "dist/index.js")))

    def test_traversal_refused(self):
        self.assertEqual(self.run_prepare(self.good(**{"../escape.js": b"x"})), 1)
        self.assertFalse(os.path.exists(os.path.join(self.dir, "escape.js")))

    def test_absolute_refused(self):
        self.assertEqual(self.run_prepare(self.good(**{"/tmp/abs.js": b"x"})), 1)

    def test_other_files_refused(self):
        self.assertEqual(self.run_prepare(self.good(**{".npmrc": b"registry=evil"})), 1)

    def test_missing_entry(self):
        self.assertEqual(self.run_prepare({"wrangler.toml": TOML.encode(), "dist/other.js": b"x"}), 1)

    def test_missing_env(self):
        cfg ='name = "app"\n[env.staging]\n'
        self.assertEqual(self.run_prepare({"dist/index.js": b"x", "wrangler.toml": cfg.encode()}), 1)

    def test_env_build_stripped(self):
        cfg = TOML + '\n[env.preview.build]\ncommand = "curl evil"\n'
        cfg = cfg.replace("[env.preview]\n", "")
        self.assertEqual(self.run_prepare({"dist/index.js": b"x", "wrangler.toml": cfg.encode()}), 0)
        with open(os.path.join(self.out, "wrangler.json")) as f:
            self.assertNotIn("build", json.load(f)["env"]["preview"])

    def test_refused_sections(self):
        for section in ("assets", "containers", "site"):
            with self.subTest(section=section):
                cfg = f'name = "app"\n[{section}]\ndirectory = "public"\n[env.preview]\n'
                self.assertEqual(self.run_prepare({"dist/index.js": b"x", "wrangler.toml": cfg.encode()}), 1)

    def test_jsonc(self):
        cfg = """{
  // a comment with "quotes"
  "name": "app", /* block */
  "vars": {"URL": "https://example.com//path"},
  "build": {"command": "make"},
  "env": {"preview": {}, "staging": {},},
}"""
        self.assertEqual(self.run_prepare({"dist/index.js": b"x", "wrangler.jsonc": cfg.encode()},
                                          config="wrangler.jsonc"), 0)
        with open(os.path.join(self.out, "wrangler.json")) as f:
            parsed = json.load(f)
        self.assertEqual(parsed["vars"]["URL"], "https://example.com//path")
        self.assertNotIn("build", parsed)

    def test_bad_version_ignored(self):
        files = self.good(**{"package.json": b'{"version": "1.0; rm -rf /"}'})
        self.assertEqual(self.run_prepare(files), 0)
        with open(os.path.join(self.out, "build-id")) as f:
            self.assertEqual(f.read(), "0.0.0+0123456")


if __name__ == "__main__":
    unittest.main()
