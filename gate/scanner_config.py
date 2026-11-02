#!/usr/bin/env python3
"""Make the scanners read their config from the PR's base commit (#61).

Scanners look for config and ignore files in the directory they scan, which is
the PR's checkout. A PR could add a `.gitleaksignore` entry, or widen a
`.semgrepignore`, and hide its own findings. This removes every scanner config
file from the checkout and writes back the base commit's copies, so a PR is
scanned with the config that was already merged. Those files are tier 3, so
changing one needs the approver and takes effect from the next PR.

    python3 gate/scanner_config.py <checkout-dir>

Environment:

    GH_TOKEN   token with contents:read
    REPO       owner/repo
    BASE_SHA   the PR's base commit

Exit code 0 when the checkout holds exactly the base commit's config files;
1 on any error, so the scan job fails closed. Standard library only.
"""

import base64
import json
import os
import sys
import tomllib
import urllib.request

API = "https://api.github.com"

# Files a scanner reads from the directory it scans. gitleaks loads
# `.gitleaks.toml`, then any `.gitleaks.<ext>` viper finds, and
# `.gitleaksignore`; Semgrep reads `.semgrepignore`; osv-scanner reads
# `osv-scanner.toml` next to each manifest; trivy takes its ignore file by
# flag. The tier maps list the same names at tier 3.
NAMES = {
    ".gitleaksignore",
    ".semgrepignore",
    "osv-scanner.toml",
    ".osv-scanner.toml",
    ".trivyignore",
    ".trivyignore.yaml",
    "trivy.yaml",
}
PREFIXES = (".gitleaks.",)

REGULAR_MODES = {"100644", "100755"}


class Refused(Exception):
    pass


def is_config(path: str) -> bool:
    name = path.rsplit("/", 1)[-1]
    return name in NAMES or name.startswith(PREFIXES)


def request(path: str):
    req = urllib.request.Request(API + path, headers={
        "Authorization": f"Bearer {os.environ['GH_TOKEN']}",
        "Accept": "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
    })
    with urllib.request.urlopen(req) as response:
        return json.load(response)


def base_files(repo: str, sha: str):
    """{path: bytes} for every scanner config file in the base commit."""
    tree = request(f"/repos/{repo}/git/trees/{sha}?recursive=1")
    if tree.get("truncated"):
        raise Refused("the base commit's file tree is too large to list in one call")
    files = {}
    for entry in tree.get("tree", []):
        if entry.get("type") != "blob" or not is_config(entry["path"]):
            continue
        if entry.get("mode") not in REGULAR_MODES:
            raise Refused(f"{entry['path']} in the base commit is not a regular file")
        blob = request(f"/repos/{repo}/git/blobs/{entry['sha']}")
        files[entry["path"]] = base64.b64decode(blob["content"])
    return files


def candidate_files(root: str):
    """Paths, relative to root, of scanner config files in the checkout."""
    found = []
    for directory, dirs, names in os.walk(root):
        dirs[:] = [d for d in dirs if d != ".git"]
        for name in names:
            path = os.path.relpath(os.path.join(directory, name), root)
            if is_config(path.replace(os.sep, "/")):
                found.append(path)
    return sorted(found)


def check_gitleaks_config(path: str, content: bytes):
    """Refuse a gitleaks config that extends a file the PR could change."""
    if not path.endswith(".toml"):
        return
    try:
        config = tomllib.loads(content.decode())
    except (tomllib.TOMLDecodeError, UnicodeDecodeError) as error:
        raise Refused(f"{path} in the base commit doesn't parse: {error}")
    if config.get("extend", {}).get("path"):
        raise Refused(f"{path} uses [extend] path, which would read a file from the PR. "
                      "Use useDefault or put the rules in this file")


def write_inside(root: str, path: str, content: bytes):
    """Write root/path, refusing to follow a link the PR planted out of root."""
    real_root = os.path.realpath(root)
    target = os.path.join(root, path)
    parent = os.path.dirname(target)
    os.makedirs(parent, exist_ok=True)
    real_parent = os.path.realpath(parent)
    if real_parent != real_root and not real_parent.startswith(real_root + os.sep):
        raise Refused(f"{path}: a directory on its path leads outside the checkout")
    if os.path.lexists(target):
        os.remove(target)
    with open(target, "wb") as f:
        f.write(content)


def apply(root: str, base: dict):
    """Replace the checkout's config files with the base commit's.

    Returns the paths where the PR's copy differed from the base commit's.
    """
    for path, content in base.items():
        if path.rsplit("/", 1)[-1].startswith(".gitleaks."):
            check_gitleaks_config(path, content)
    pr = {}
    for path in candidate_files(root):
        full = os.path.join(root, path)
        content = None
        if not os.path.islink(full):
            with open(full, "rb") as f:
                content = f.read()
        pr[path.replace(os.sep, "/")] = content
        os.remove(full)
    for path, content in sorted(base.items()):
        write_inside(root, path, content)
    return sorted(p for p in set(pr) | set(base) if pr.get(p) != base.get(p))


def main(argv) -> int:
    if len(argv) != 1:
        print(__doc__.strip(), file=sys.stderr)
        return 1
    root = argv[0]
    try:
        base = base_files(os.environ["REPO"], os.environ["BASE_SHA"])
        changed = apply(root, base)
    except (Refused, OSError, KeyError, ValueError) as error:
        print(f"Scanner config: refused. {error}")
        return 1
    print(f"Scanner config from the base commit: {', '.join(sorted(base)) or 'none'}.")
    if changed:
        print(f"The PR's changes to these were ignored: {', '.join(changed)}.")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
