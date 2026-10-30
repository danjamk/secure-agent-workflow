#!/usr/bin/env python3
"""Compare the settings bootstrap wants with what GitHub returns.

    python3 bootstrap/diff.py <desired.json> <current.json>

Prints one line per differing field and exits 1 if anything differs, 0 if not.
Desired is a subset: fields GitHub returns that bootstrap doesn't manage are
ignored. Lists are compared as sets of items, keyed by "type" (ruleset rules)
or "context" (required checks), so GitHub's ordering doesn't count as a change.
"""

import json
import sys


def sort_key(item):
    if isinstance(item, dict):
        return str(item.get("type", item.get("context", json.dumps(item, sort_keys=True))))
    return json.dumps(item, sort_keys=True)


def diff(desired, current, path):
    if isinstance(desired, dict):
        if not isinstance(current, dict):
            return [(path, current, desired)]
        changes = []
        for key, value in desired.items():
            changes += diff(value, current.get(key), f"{path}.{key}" if path else key)
        return changes
    if isinstance(desired, list):
        if not isinstance(current, list):
            return [(path, current, desired)]
        if all(isinstance(i, dict) for i in desired + current):
            # Keyed lists (rules, checks): report added and removed items by key,
            # and recurse into items present on both sides.
            want = {sort_key(i): i for i in desired}
            have = {sort_key(i): i for i in current}
            changes = []
            for key in sorted(want.keys() | have.keys()):
                item_path = f"{path}[{key}]"
                if key not in have:
                    changes.append((item_path, None, want[key]))
                elif key not in want:
                    changes.append((item_path, have[key], None))
                else:
                    changes += diff(want[key], have[key], item_path)
            return changes
        if sorted(desired, key=sort_key) != sorted(current, key=sort_key):
            return [(path, current, desired)]
        return []
    return [] if desired == current else [(path, current, desired)]


def main() -> None:
    if len(sys.argv) != 3:
        sys.exit("Usage: diff.py <desired.json> <current.json>")
    with open(sys.argv[1]) as f:
        desired = json.load(f)
    with open(sys.argv[2]) as f:
        current = json.load(f)
    changes = diff(desired, current, "")
    for path, was, want in changes:
        print(f"{path or '(all)'}: {json.dumps(was)} -> {json.dumps(want)}")
    sys.exit(1 if changes else 0)


if __name__ == "__main__":
    main()
