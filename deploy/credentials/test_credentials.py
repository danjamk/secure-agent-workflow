"""Tests for the credential tool and the Cloudflare checker (ADR-007).

    python3 -m unittest discover -s deploy/credentials
"""

import datetime as dt
import importlib.machinery
import importlib.util
import unittest
from pathlib import Path

import credentials as c

HERE = Path(__file__).resolve().parent
_loader = importlib.machinery.SourceFileLoader("cloudflare_check", str(HERE / "checks" / "cloudflare"))
_spec = importlib.util.spec_from_loader("cloudflare_check", _loader)
cf = importlib.util.module_from_spec(_spec)
_loader.exec_module(cf)

TODAY = dt.date(2026, 11, 1)

GOOD = """\
# comment
credentials:
  - name: cloudflare-deploy-token   # trailing comment
    system: cloudflare
    target: dev
    exposure: preview
    purpose: "Deploy # not a comment"
    check: workers kv
    rotate_days: 90
  - name: stripe-secret-key
    system: stripe
    target: prod
    exposure: prod
    purpose: Payments
"""


def entry(**over):
    e = {"name": "tok", "system": "cloudflare", "target": "dev", "exposure": "preview",
         "purpose": "p", "check": [], "rotate_days": 90}
    e.update(over)
    return e


def check(fails=(), expires=None, identity=("acct1", "Dev")):
    return {"lines": [], "fails": list(fails), "expires": expires, "identity": identity}


class Manifest(unittest.TestCase):
    def test_parses_entries(self):
        entries = c.parse_manifest(GOOD)
        self.assertEqual(len(entries), 2)
        first = entries[0]
        self.assertEqual(first["name"], "cloudflare-deploy-token")
        self.assertEqual(first["purpose"], "Deploy # not a comment")
        self.assertEqual(first["check"], ["workers", "kv"])
        self.assertEqual(first["rotate_days"], 90)
        self.assertEqual(entries[1]["check"], [])

    def test_example_manifest_parses(self):
        entries = c.parse_manifest((HERE / "credentials.example.yml").read_text())
        self.assertEqual([e["exposure"] for e in entries], ["preview", "preview", "staging"])

    def bad(self, text, fragment):
        with self.assertRaises(ValueError) as ctx:
            c.parse_manifest(text)
        self.assertIn(fragment, str(ctx.exception))

    def test_rejects_wrong_root(self):
        self.bad("secrets:\n", "expected 'credentials:'")

    def test_rejects_unknown_field(self):
        self.bad(GOOD + "    colour: red\n", "unknown field")

    def test_rejects_missing_required(self):
        self.bad("credentials:\n  - name: a\n    system: x\n    target: dev\n    exposure: preview\n", "missing 'purpose'")

    def test_rejects_prod_exposure_on_dev(self):
        self.bad(GOOD.replace("exposure: preview", "exposure: prod"), "must be preview or staging")

    def test_rejects_dev_exposure_on_prod(self):
        self.bad(GOOD.replace("exposure: prod", "exposure: staging"), "must be prod")

    def test_rejects_reserved_name(self):
        self.bad(GOOD.replace("stripe-secret-key", "stripe-account-id"), "reserved")

    def test_rejects_duplicate(self):
        dup = GOOD + GOOD.split("credentials:\n", 1)[1]
        self.bad(dup, "declared twice")

    def test_rejects_bad_rotate_days(self):
        self.bad(GOOD.replace("rotate_days: 90", "rotate_days: soon"), "rotate_days")

    def test_rejects_field_given_twice(self):
        self.bad(GOOD.replace("    system: stripe\n", "    system: stripe\n    system: x\n"), "given twice")

    def test_rejects_name_without_system_prefix(self):
        self.bad(GOOD.replace("stripe-secret-key", "payments-secret-key"), "<system>-<role>-<kind>")

    def test_rejects_name_without_kind(self):
        self.bad(GOOD.replace("stripe-secret-key", "stripe-secret"), "<system>-<role>-<kind>")

    def test_rejects_name_without_role(self):
        self.bad(GOOD.replace("stripe-secret-key", "stripe-key"), "<system>-<role>-<kind>")

    def test_dashboard_name(self):
        e = entry(name="cloudflare-deploy-token")
        self.assertEqual(c.dashboard_name("agent-testbed", e), "agent-testbed-dev-cloudflare-deploy-token")

    def test_status_lines_carry_dashboard_name(self):
        out = c.evaluate(entry(name="cloudflare-deploy-token"), None, None, {}, None, TODAY, "danjamk/app")
        self.assertIn("cloudflare-deploy-token [app-dev-cloudflare-deploy-token]: missing", out[0][1])
        self.assertIn("broker.sh setup danjamk/app", out[0][1])

    def test_paths(self):
        e = entry(name="cloudflare-infra-token", exposure="staging")
        self.assertEqual(c.param_path("app", e), "/app/dev/staging/cloudflare-infra-token")
        self.assertEqual(c.identity_path("app", "cloudflare", "dev"), "/app/dev/preview/cloudflare-account-id")
        self.assertEqual(c.identity_path("app", "cloudflare", "prod"), "/app/prod/prod/cloudflare-account-id")


class CheckerOutput(unittest.TestCase):
    def test_parses_lines(self):
        r = c.parse_check("PASS ok\nINFO note\nEXPIRES 2027-01-31\nIDENTITY abc123 Dev Account\n", 0)
        self.assertEqual(r["fails"], [])
        self.assertEqual(r["expires"], dt.date(2027, 1, 31))
        self.assertEqual(r["identity"], ("abc123", "Dev Account"))
        self.assertEqual(r["lines"], [("PASS", "ok"), ("INFO", "note")])

    def test_nonzero_exit_without_fail_line_fails(self):
        self.assertEqual(c.parse_check("PASS ok\n", 2)["fails"], ["checker exited 2"])

    def test_fail_line(self):
        self.assertEqual(c.parse_check("FAIL nope\n", 1)["fails"], ["nope"])


class Evaluate(unittest.TestCase):
    def levels(self, out):
        return [level for level, _ in out]

    def test_missing(self):
        self.assertEqual(self.levels(c.evaluate(entry(), None, None, {}, None, TODAY)), ["FAIL"])

    def test_placeholder(self):
        out = c.evaluate(entry(), "placeholder", None, {}, None, TODAY)
        self.assertIn("placeholder", out[0][1])

    def test_passing(self):
        out = c.evaluate(entry(), "v", check(), {"saw:set-at": "2026-10-30T00:00:00Z"}, "acct1", TODAY)
        self.assertEqual(self.levels(out), ["PASS"])

    def test_check_fails(self):
        out = c.evaluate(entry(), "v", check(fails=["revoked"]), {}, "acct1", TODAY)
        self.assertEqual(self.levels(out), ["FAIL"])
        self.assertIn("revoked", out[0][1])

    def test_wrong_account(self):
        out = c.evaluate(entry(), "v", check(identity=("other", "Prod")), {}, "acct1", TODAY)
        self.assertEqual(self.levels(out), ["FAIL"])

    def test_expiring_soon_warns(self):
        out = c.evaluate(entry(), "v", check(expires=TODAY + dt.timedelta(days=10)), {}, "acct1", TODAY)
        self.assertEqual(self.levels(out), ["PASS", "WARN"])

    def test_expired_fails(self):
        out = c.evaluate(entry(), "v", check(expires=TODAY), {}, "acct1", TODAY)
        self.assertEqual(self.levels(out), ["FAIL"])

    def test_rotation_overdue_warns(self):
        out = c.evaluate(entry(rotate_days=30), "v", check(), {"saw:set-at": "2026-08-01T00:00:00Z"}, "acct1", TODAY)
        self.assertEqual(self.levels(out), ["PASS", "WARN"])

    def test_unchecked_warns(self):
        out = c.evaluate(entry(system="stripe"), "v", None, {}, None, TODAY)
        self.assertEqual(self.levels(out), ["WARN"])


class Paste(unittest.TestCase):
    TOKEN = "abcdefghijklmnopqrstuvwxyz0123456789WXYZ"

    def test_received_shows_length_and_last_four(self):
        self.assertEqual(c.received(self.TOKEN), "Received 40 characters, ending in WXYZ.")

    def test_received_hides_tail_of_short_values(self):
        self.assertEqual(c.received("short-value"), "Received 11 characters.")

    def test_whitespace_refused(self):
        self.assertIn("spaces or line breaks", c.paste_problem("abc def", "x-deploy-token", {}))

    def test_same_value_for_another_credential_refused(self):
        seen = {c.fingerprint(self.TOKEN): "cloudflare-deploy-token"}
        self.assertIn("same value as cloudflare-deploy-token",
                      c.paste_problem(self.TOKEN, "cloudflare-read-token", seen))

    def test_same_value_for_itself_allowed(self):
        seen = {c.fingerprint(self.TOKEN): "cloudflare-deploy-token"}
        self.assertIsNone(c.paste_problem(self.TOKEN, "cloudflare-deploy-token", seen))


class Confirm(unittest.TestCase):
    """confirm() on a real pseudo-terminal. It once opened the tty "r+", which
    raises on a terminal, so every first credential was refused without a prompt."""

    def answer(self, typed: str) -> bool:
        import os
        import pty
        master, slave = pty.openpty()
        try:
            os.write(master, typed.encode())
            return c.confirm("Type yes: ", tty=os.ttyname(slave))
        finally:
            os.close(master)
            os.close(slave)

    def test_yes(self):
        self.assertTrue(self.answer("yes\n"))

    def test_anything_else(self):
        self.assertFalse(self.answer("y\n"))


class Cloudflare(unittest.TestCase):
    def fake(self, responses):
        """responses: path prefix -> (ok, body). Unlisted paths succeed with an empty list."""
        calls = []

        def call(token, path):
            calls.append(path)
            for prefix, resp in responses.items():
                if path.startswith(prefix):
                    return resp
            return True, {"success": True, "result": []}
        return call, calls

    BASE = {
        "user/tokens/verify": (True, {"success": True, "result": {"status": "active", "expires_on": "2027-02-01T00:00:00Z"}}),
        "accounts?": (True, {"success": True, "result": [{"id": "acct1", "name": "Dev"}]}),
        "zones?": (True, {"success": True, "result": [], "result_info": {"total_count": 0}}),
    }
    DENIED = (False, {"success": False, "errors": [{"code": 10000, "message": "Authentication error"}]})

    def test_good_token(self):
        call, calls = self.fake(dict(self.BASE))
        out = cf.run("t", ["workers", "kv"], call=call)
        self.assertFalse([l for l in out if l.startswith("FAIL")], out)
        self.assertIn("IDENTITY acct1 Dev", out)
        self.assertIn("EXPIRES 2027-02-01", out)
        self.assertIn("accounts/acct1/workers/scripts", calls)
        self.assertIn("accounts/acct1/storage/kv/namespaces", calls)

    def test_inactive_token(self):
        r = dict(self.BASE)
        r["user/tokens/verify"] = (False, {"success": False, "errors": [{"code": 1000, "message": "Invalid API Token"}]})
        out = cf.run("t", [], call=self.fake(r)[0])
        self.assertEqual(len(out), 1)
        self.assertTrue(out[0].startswith("FAIL token not accepted"))

    def test_two_accounts(self):
        r = dict(self.BASE)
        r["accounts?"] = (True, {"success": True, "result": [{"id": "a"}, {"id": "b"}]})
        out = cf.run("t", [], call=self.fake(r)[0])
        self.assertTrue(out[-1].startswith("FAIL token reaches 2 accounts"))

    ZONE = (True, {"success": True, "result": [{"id": "z1", "name": "example.com"}], "result_info": {"total_count": 1}})

    def test_zone_listed_but_not_readable_passes(self):
        # Seen live: Workers Scripts lets a token list zone names, nothing more.
        r = dict(self.BASE, **{"zones?": self.ZONE, "zones/z1/": self.DENIED})
        out = cf.run("t", [], call=self.fake(r)[0])
        self.assertFalse([l for l in out if l.startswith("FAIL")], out)
        self.assertIn("INFO lists 1 zone(s) (example.com) but can't read their DNS records or settings", out)

    def test_zone_dns_readable_fails(self):
        r = dict(self.BASE, **{"zones?": self.ZONE, "zones/z1/settings": self.DENIED})
        out = cf.run("t", [], call=self.fake(r)[0])
        self.assertIn("FAIL can read DNS records of example.com; this token should have no zone permissions", out)

    def test_zones_allowed(self):
        r = dict(self.BASE, **{"zones?": self.ZONE})
        self.assertIn("INFO reaches 1 zone(s)", cf.run("t", ["zones"], call=self.fake(r)[0]))

    def test_missing_permission(self):
        r = dict(self.BASE)
        r["accounts/acct1/d1"] = (False, {"success": False, "errors": [{"code": 10000, "message": "Authentication error"}]})
        out = cf.run("t", ["d1"], call=self.fake(r)[0])
        self.assertIn("FAIL cannot list D1 databases: Authentication error (code 10000)", out)

    def test_unknown_word(self):
        self.assertEqual(cf.run("t", ["dns"], call=self.fake(self.BASE)[0]), ["FAIL unknown check words: dns"])

    def test_never_prints_token(self):
        secret = "s3cr3t-token-value"
        call, _ = self.fake(dict(self.BASE))
        self.assertFalse([l for l in cf.run(secret, ["workers"], call=call) if secret in l])


if __name__ == "__main__":
    unittest.main()
