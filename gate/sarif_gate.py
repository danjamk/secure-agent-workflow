#!/usr/bin/env python3
"""Fail on SARIF findings at or above a severity threshold.

    python3 gate/sarif_gate.py <sarif-file-or-dir> [--min-security-severity 7.0]

CodeQL uploads its results but never fails the job, so this turns them into a
pass or fail. A finding blocks when its rule has a security-severity at or
above the threshold (7.0 is "high"), or when it has no security-severity and
its level is "error".

Exit code 0 if nothing blocks, 1 otherwise.
"""

import json
import os
import sys


def sarif_files(target: str):
    if os.path.isdir(target):
        for name in sorted(os.listdir(target)):
            if name.endswith(".sarif"):
                yield os.path.join(target, name)
    else:
        yield target


def blocking(sarif: dict, threshold: float):
    """Yield (rule id, severity label, location) for each blocking finding."""
    for run in sarif.get("runs", []):
        rules = {}
        for rule in run.get("tool", {}).get("driver", {}).get("rules", []):
            rules[rule.get("id")] = rule
        for result in run.get("results", []):
            rule = rules.get(result.get("ruleId"), {})
            properties = rule.get("properties", {})
            level = result.get("level") or rule.get("defaultConfiguration", {}).get("level", "warning")
            score = properties.get("security-severity")
            if score is not None:
                if float(score) < threshold:
                    continue
                label = f"security-severity {score}"
            elif level != "error":
                continue
            else:
                label = "level error"
            location = "unknown location"
            locations = result.get("locations") or []
            if locations:
                physical = locations[0].get("physicalLocation", {})
                uri = physical.get("artifactLocation", {}).get("uri", "?")
                line = physical.get("region", {}).get("startLine", "?")
                location = f"{uri}:{line}"
            yield result.get("ruleId", "?"), label, location


def main(argv) -> int:
    if not argv:
        print(__doc__.strip(), file=sys.stderr)
        return 1
    threshold = 7.0
    if "--min-security-severity" in argv:
        threshold = float(argv[argv.index("--min-security-severity") + 1])
    findings = []
    for path in sarif_files(argv[0]):
        with open(path) as f:
            findings += list(blocking(json.load(f), threshold))
    for rule_id, label, location in findings:
        print(f"BLOCKING  {rule_id}  ({label})  {location}")
    print(f"{len(findings)} blocking finding(s) at security-severity >= {threshold} or level error.")
    return 1 if findings else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
