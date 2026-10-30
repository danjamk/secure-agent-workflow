#!/usr/bin/env python3
"""Tier check: compute a PR's tier from its changed paths, and fail until the
approval that tier needs exists (ADR-003, spec 0001 "Merge gate").

Runs inside .github/workflows/tier-check.yml. Environment:

    GH_TOKEN             token with contents:read and pull-requests:read
    REPO                 owner/repo
    PR_NUMBER            the pull request
    APPROVER             login whose approval counts (default: the repo owner)
    TIER_MAP             tier map path in the repo (default standards/tier-map.yml)
    DEFAULT_TIER_MAP     local file used when the repo has no tier map at the base
    GITHUB_STEP_SUMMARY  optional; the result is appended here as markdown

Exit code 0 passes the check; 1 fails it. Standard library only, so the check
installs nothing at run time.
"""

import base64
import json
import os
import re
import sys
import urllib.error
import urllib.request

API = "https://api.github.com"
UNMATCHED_TIER = 2
MAX_FILES = 3000  # GitHub's list-files endpoint stops here


# --- Tier map ---

def parse_tier_map(text: str) -> dict:
    """Parse the tier map's one accepted shape into {tier: [patterns]}.

    A full YAML parser would need a dependency. The map is small and its shape
    is fixed, so anything outside that shape is an error: the check fails
    closed rather than guessing.
    """
    tiers: dict = {}
    current = None
    seen_root = False
    for number, raw in enumerate(text.splitlines(), 1):
        line = raw.rstrip()
        stripped = line.strip()
        if not stripped or stripped.startswith("#"):
            continue
        if not seen_root:
            if line != "tiers:":
                raise ValueError(f"line {number}: expected 'tiers:'")
            seen_root = True
            continue
        tier_key = re.fullmatch(r"\s+([123]):", line)
        item = re.fullmatch(r"\s+-\s+(.+)", line)
        if tier_key:
            current = int(tier_key.group(1))
            if current in tiers:
                raise ValueError(f"line {number}: tier {current} listed twice")
            tiers[current] = []
        elif item and current is not None:
            pattern = item.group(1).strip()
            if len(pattern) >= 2 and pattern[0] == pattern[-1] and pattern[0] in "\"'":
                pattern = pattern[1:-1]
            tiers[current].append(pattern)
        else:
            raise ValueError(f"line {number}: unexpected {stripped!r}")
    if not seen_root:
        raise ValueError("empty tier map")
    return tiers


def glob_to_regex(pattern: str) -> re.Pattern:
    """Anchored at the repo root. '**/' spans directories, '*' and '?' don't."""
    out = []
    i = 0
    while i < len(pattern):
        if pattern.startswith("**/", i):
            out.append("(?:.*/)?")
            i += 3
        elif pattern.startswith("**", i):
            out.append(".*")
            i += 2
        elif pattern[i] == "*":
            out.append("[^/]*")
            i += 1
        elif pattern[i] == "?":
            out.append("[^/]")
            i += 1
        else:
            out.append(re.escape(pattern[i]))
            i += 1
    return re.compile("".join(out) + r"\Z")


def tier_of(path: str, tier_map: dict):
    """Highest tier whose patterns match the path, and the pattern that matched."""
    for tier in sorted(tier_map, reverse=True):
        for pattern in tier_map[tier]:
            if glob_to_regex(pattern).match(path):
                return tier, pattern
    return UNMATCHED_TIER, None


def classify(paths, tier_map: dict):
    """The PR's tier and every path's classification, highest tier first."""
    rows = [(path, *tier_of(path, tier_map)) for path in sorted(set(paths))]
    rows.sort(key=lambda row: (-row[1], row[0]))
    return (max(row[1] for row in rows) if rows else 1), rows


# --- Decision ---

def decide(tier, author_login, author_type, approver, head_sha, reviews):
    """Return (passed, reason). Reviews are in the order GitHub returns them,
    which is oldest first."""
    if tier == 3 and author_type != "User":
        return False, (f"Tier 3 paths can't be changed by a bot (@{author_login}). "
                       "A human has to author this change.")
    if tier == 1:
        return True, "Tier 1: no approval needed."
    if author_login.lower() == approver.lower() and author_type == "User":
        # GitHub won't let an author approve their own PR, so the approver
        # authoring it is the approval.
        return True, f"Tier {tier}: authored by the approver @{approver}."

    # The approver's latest review that sets a state. COMMENTED reviews don't
    # change approval state on GitHub, so they don't here either.
    latest = None
    for review in reviews:
        user = review.get("user") or {}
        if (user.get("login", "").lower() == approver.lower()
                and user.get("type") == "User"
                and review.get("state") in ("APPROVED", "CHANGES_REQUESTED", "DISMISSED")):
            latest = review
    if latest is None:
        return False, f"Tier {tier}: waiting for approval from @{approver}."
    if latest["state"] != "APPROVED":
        return False, (f"Tier {tier}: @{approver}'s latest review is "
                       f"{latest['state'].lower().replace('_', ' ')}.")
    if latest.get("commit_id") != head_sha:
        return False, (f"Tier {tier}: @{approver} approved {latest.get('commit_id', '')[:7]}, "
                       f"but the PR is now at {head_sha[:7]}. Approve the latest commit.")
    return True, f"Tier {tier}: approved by @{approver} on {head_sha[:7]}."


# --- GitHub API ---

def request(path: str):
    req = urllib.request.Request(API + path, headers={
        "Authorization": f"Bearer {os.environ['GH_TOKEN']}",
        "Accept": "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
    })
    with urllib.request.urlopen(req) as response:
        return json.load(response)


def paged(path: str):
    items, page = [], 1
    while True:
        sep = "&" if "?" in path else "?"
        batch = request(f"{path}{sep}per_page=100&page={page}")
        items += batch
        if len(batch) < 100:
            return items
        page += 1


def fetch_tier_map(repo: str, ref: str, path: str):
    try:
        body = request(f"/repos/{repo}/contents/{path}?ref={ref}")
    except urllib.error.HTTPError as error:
        if error.code == 404:
            return None
        raise
    return base64.b64decode(body["content"]).decode()


# --- Output ---

def summary(tier, passed, reason, rows, source):
    lines = [
        f"## Tier check: tier {tier}, {'passed' if passed else 'failed'}",
        "",
        reason,
        "",
        f"Tier map: {source}",
        "",
        "| Path | Tier | Matched |",
        "| --- | --- | --- |",
    ]
    for path, tier_value, pattern in rows[:50]:
        lines.append(f"| `{path}` | {tier_value} | {f'`{pattern}`' if pattern else 'no rule'} |")
    if len(rows) > 50:
        lines.append(f"| … {len(rows) - 50} more | | |")
    return "\n".join(lines) + "\n"


def main() -> int:
    repo = os.environ["REPO"]
    number = os.environ["PR_NUMBER"]
    map_path = os.environ.get("TIER_MAP") or "standards/tier-map.yml"

    pr = request(f"/repos/{repo}/pulls/{number}")
    approver = os.environ.get("APPROVER") or pr["base"]["repo"]["owner"]["login"]
    head_sha = pr["head"]["sha"]
    base_sha = pr["base"]["sha"]

    # The map comes from the base commit, never the PR, so a PR can't edit
    # the map that judges it.
    text = fetch_tier_map(repo, base_sha, map_path)
    source = f"`{map_path}` at base {base_sha[:7]}"
    if text is None:
        text = open(os.environ["DEFAULT_TIER_MAP"]).read()
        source = "secure-agent-workflow default (the repo has none at the base commit)"
    tier_map = parse_tier_map(text)

    if pr["changed_files"] > MAX_FILES:
        passed, reason, tier, rows = False, (
            f"The PR changes {pr['changed_files']} files; GitHub lists at most "
            f"{MAX_FILES}, so the tier can't be computed. Split the PR."), 3, []
    else:
        paths = []
        for changed in paged(f"/repos/{repo}/pulls/{number}/files"):
            paths.append(changed["filename"])
            # A rename changes the old path too: moving a tier 3 file out of
            # place is a tier 3 change.
            if changed.get("previous_filename"):
                paths.append(changed["previous_filename"])
        tier, rows = classify(paths, tier_map)
        reviews = paged(f"/repos/{repo}/pulls/{number}/reviews")
        passed, reason = decide(tier, pr["user"]["login"], pr["user"]["type"],
                                approver, head_sha, reviews)

    report = summary(tier, passed, reason, rows, source)
    print(report)
    if os.environ.get("GITHUB_STEP_SUMMARY"):
        with open(os.environ["GITHUB_STEP_SUMMARY"], "a") as f:
            f.write(report)
    return 0 if passed else 1


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception as error:  # noqa: BLE001 — any failure fails the check
        print(f"Tier check could not run: {error}", file=sys.stderr)
        sys.exit(1)
