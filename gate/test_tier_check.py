"""Tests for tier_check.py. Run: python3 -m unittest discover -s gate"""

import contextlib
import os
import unittest

import tier_check

HERE = os.path.dirname(os.path.abspath(__file__))
DEFAULT_MAP = tier_check.parse_tier_map(
    open(os.path.join(HERE, "..", "standards", "tier-map.yml")).read())

HEAD = "a" * 40
OLD = "b" * 40


def review(login, state, commit=HEAD, user_type="User"):
    return {"user": {"login": login, "type": user_type}, "state": state, "commit_id": commit}


class TierMapTest(unittest.TestCase):
    def test_default_map_parses(self):
        self.assertEqual(sorted(DEFAULT_MAP), [1, 2, 3])
        self.assertIn("standards/tier-map.yml", DEFAULT_MAP[3])

    def test_quoted_patterns_are_unquoted(self):
        self.assertIn("**/package.json", DEFAULT_MAP[2])

    def test_rejects_unknown_structure(self):
        for text in ("tiers:\n  4:\n    - x\n",
                     "tiers:\n  1:\n    - x\nother: y\n",
                     "nope:\n",
                     "",
                     "tiers:\n  1:\n    - a\n  1:\n    - b\n"):
            with self.subTest(text=text), self.assertRaises(ValueError):
                tier_check.parse_tier_map(text)


class GlobTest(unittest.TestCase):
    def match(self, pattern, path):
        return bool(tier_check.glob_to_regex(pattern).match(path))

    def test_anchored_at_root(self):
        self.assertTrue(self.match("CODEOWNERS", "CODEOWNERS"))
        self.assertFalse(self.match("CODEOWNERS", "src/CODEOWNERS"))

    def test_double_star_slash_spans_directories(self):
        self.assertTrue(self.match("**/package.json", "package.json"))
        self.assertTrue(self.match("**/package.json", "a/b/package.json"))
        self.assertFalse(self.match("**/package.json", "a/package.json.bak"))

    def test_trailing_double_star(self):
        self.assertTrue(self.match(".github/**", ".github/workflows/ci.yml"))
        self.assertFalse(self.match(".github/**", ".githubx/file"))

    def test_single_star_stays_in_directory(self):
        self.assertTrue(self.match("**/requirements*.txt", "requirements-dev.txt"))
        self.assertFalse(self.match("src/*", "src/a/b.ts"))


class ClassifyTest(unittest.TestCase):
    def tier(self, *paths):
        return tier_check.classify(paths, DEFAULT_MAP)[0]

    def test_each_tier(self):
        self.assertEqual(self.tier("src/app.ts", "docs/guide.md"), 1)
        self.assertEqual(self.tier("src/app.ts", "package.json"), 2)
        self.assertEqual(self.tier("src/app.ts", ".github/workflows/ci.yml"), 3)

    def test_highest_tier_wins(self):
        self.assertEqual(self.tier("src/auth/session.ts"), 2)
        self.assertEqual(self.tier("worker/wrangler.jsonc"), 2)
        self.assertEqual(self.tier("db/migrations/0001.sql"), 2)

    def test_unmatched_path_is_tier_2(self):
        self.assertEqual(self.tier("Makefile"), 2)
        rows = tier_check.classify(["Makefile"], DEFAULT_MAP)[1]
        self.assertEqual(rows, [("Makefile", 2, None)])

    def test_tier_map_and_codeowners_are_tier_3(self):
        self.assertEqual(self.tier("standards/tier-map.yml"), 3)
        self.assertEqual(self.tier("CODEOWNERS"), 3)
        self.assertEqual(self.tier("docs/CODEOWNERS"), 3)
        self.assertEqual(self.tier(".github/CODEOWNERS"), 3)

    def test_no_files_is_tier_1(self):
        self.assertEqual(self.tier(), 1)


class DecideTest(unittest.TestCase):
    def decide(self, tier, reviews=(), author="danjamk-build-agent[bot]", author_type="Bot"):
        return tier_check.decide(tier, author, author_type, "danjamk", HEAD, list(reviews))[0]

    def test_tier_1_passes_without_approval(self):
        self.assertTrue(self.decide(1))

    def test_tier_2_waits_for_approval(self):
        self.assertFalse(self.decide(2))

    def test_tier_2_passes_on_head_approval(self):
        self.assertTrue(self.decide(2, [review("danjamk", "APPROVED")]))

    def test_stale_approval_fails(self):
        self.assertFalse(self.decide(2, [review("danjamk", "APPROVED", commit=OLD)]))

    def test_other_reviewers_dont_count(self):
        self.assertFalse(self.decide(2, [review("someone-else", "APPROVED")]))
        self.assertFalse(self.decide(2, [review("danjamk-testbed-reviewer[bot]", "APPROVED",
                                                user_type="Bot")]))

    def test_approver_login_as_bot_doesnt_count(self):
        self.assertFalse(self.decide(2, [review("danjamk", "APPROVED", user_type="Bot")]))

    def test_latest_state_wins(self):
        self.assertFalse(self.decide(2, [review("danjamk", "APPROVED"),
                                         review("danjamk", "CHANGES_REQUESTED")]))
        self.assertTrue(self.decide(2, [review("danjamk", "CHANGES_REQUESTED"),
                                        review("danjamk", "APPROVED")]))
        self.assertFalse(self.decide(2, [review("danjamk", "APPROVED"),
                                         review("danjamk", "DISMISSED")]))

    def test_comment_reviews_dont_change_state(self):
        self.assertTrue(self.decide(2, [review("danjamk", "APPROVED"),
                                        review("danjamk", "COMMENTED")]))

    def test_approver_authored_pr_passes(self):
        self.assertTrue(self.decide(2, author="danjamk", author_type="User"))
        self.assertTrue(self.decide(3, author="danjamk", author_type="User"))

    def test_bot_authored_tier_3_fails_even_when_approved(self):
        self.assertFalse(self.decide(3, [review("danjamk", "APPROVED")]))

    def test_login_comparison_ignores_case(self):
        self.assertTrue(self.decide(2, [review("DanJamK", "APPROVED")]))


class MainTest(unittest.TestCase):
    """main() against stubbed API calls."""

    BASE_MAP = open(os.path.join(HERE, "..", "standards", "tier-map.yml")).read()
    # What a PR might try: demote everything to tier 1.
    PR_MAP = "tiers:\n  1:\n    - \"**\"\n"

    def run_main(self, files, reviews=(), author=("danjamk-build-agent[bot]", "Bot")):
        fetched = []

        def request(path):
            return {"head": {"sha": HEAD}, "base": {"sha": OLD, "repo": {"owner": {"login": "danjamk"}}},
                    "user": {"login": author[0], "type": author[1]}, "changed_files": len(files)}

        def paged(path):
            if path.endswith("/files"):
                return [f if isinstance(f, dict) else {"filename": f} for f in files]
            return list(reviews)

        def fetch_tier_map(repo, ref, path):
            fetched.append(ref)
            return self.BASE_MAP if ref == OLD else self.PR_MAP

        saved = (tier_check.request, tier_check.paged, tier_check.fetch_tier_map)
        tier_check.request, tier_check.paged, tier_check.fetch_tier_map = request, paged, fetch_tier_map
        os.environ.update({"REPO": "danjamk/agent-testbed", "PR_NUMBER": "1"})
        os.environ.pop("GITHUB_STEP_SUMMARY", None)
        try:
            with open(os.devnull, "w") as devnull, contextlib.redirect_stdout(devnull):
                code = tier_check.main()
        finally:
            tier_check.request, tier_check.paged, tier_check.fetch_tier_map = saved
        return code, fetched

    def test_pr_that_edits_the_tier_map_is_judged_by_the_base_map(self):
        code, fetched = self.run_main(["standards/tier-map.yml", ".github/workflows/x.yml"])
        self.assertEqual(fetched, [OLD])
        self.assertEqual(code, 1)

    def test_rename_counts_the_old_path(self):
        moved_out = {"filename": "docs/moved", "previous_filename": ".github/CODEOWNERS"}
        self.assertEqual(self.run_main([moved_out])[0], 1)
        self.assertEqual(self.run_main(["docs/moved"])[0], 0)

    def test_tier_1_agent_pr_passes(self):
        code, _ = self.run_main(["src/app.ts"])
        self.assertEqual(code, 0)

    def test_tier_2_agent_pr_passes_only_with_head_approval(self):
        self.assertEqual(self.run_main(["package.json"])[0], 1)
        self.assertEqual(self.run_main(["package.json"], [review("danjamk", "APPROVED")])[0], 0)
        self.assertEqual(self.run_main(["package.json"],
                                       [review("danjamk", "APPROVED", commit=OLD)])[0], 1)


if __name__ == "__main__":
    unittest.main()
