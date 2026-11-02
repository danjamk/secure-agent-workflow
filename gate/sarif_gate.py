#!/usr/bin/env python3
"""Fail on SARIF findings at or above a severity threshold, and on missing output.

    python3 gate/sarif_gate.py <sarif-dir> --languages <comma list> [--min-security-severity 7.0]

CodeQL uploads its results but never fails the job, so this turns them into a
pass or fail. A finding blocks when its rule has a security-severity at or
above the threshold (7.0 is "high"), or when it has no security-severity and
its level is "error". A finding suppressed in the source still blocks: the PR
under review wrote the suppression.

Missing output never reads as a pass (#61). The check fails when the directory
holds fewer SARIF files than the languages scanned, or a file doesn't parse,
has no runs, or reports a failed run. `--languages ""` means the repo has no
language CodeQL scans, which passes and says so.

Exit code 0 if nothing blocks, 1 otherwise.
"""

import json
import os
import sys


class Invalid(Exception):
    pass


def sarif_files(target: str):
    if not os.path.isdir(target):
        raise Invalid(f"no SARIF directory at {target}")
    return [os.path.join(target, name) for name in sorted(os.listdir(target))
            if name.endswith(".sarif")]


def load(path: str) -> dict:
    """The parsed SARIF file, or Invalid if it can't count as a scan."""
    name = os.path.basename(path)
    try:
        with open(path) as f:
            doc = json.load(f)
    except (OSError, ValueError) as error:
        raise Invalid(f"{name} doesn't parse: {error}")
    runs = doc.get("runs") if isinstance(doc, dict) else None
    if not isinstance(runs, list) or not runs:
        raise Invalid(f"{name} has no runs")
    for run in runs:
        if not isinstance(run, dict) or not run.get("tool", {}).get("driver", {}).get("name"):
            raise Invalid(f"{name} has a run with no tool")
        for invocation in run.get("invocations") or []:
            if invocation.get("executionSuccessful") is False:
                raise Invalid(f"{name}: {run['tool']['driver']['name']} reports a failed run")
    return doc


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
            if result.get("suppressions"):
                label += ", suppressed in source"
            location = "unknown location"
            locations = result.get("locations") or []
            if locations:
                physical = locations[0].get("physicalLocation", {})
                uri = physical.get("artifactLocation", {}).get("uri", "?")
                line = physical.get("region", {}).get("startLine", "?")
                location = f"{uri}:{line}"
            yield result.get("ruleId", "?"), label, location


def option(argv, name, default=None):
    if name not in argv:
        return default
    i = argv.index(name)
    if i + 1 >= len(argv):
        raise Invalid(f"{name} needs a value")
    return argv[i + 1]


def main(argv) -> int:
    try:
        if not argv or argv[0].startswith("--") or "--languages" not in argv:
            raise Invalid(__doc__.strip())
        languages = [x for x in option(argv, "--languages").split(",") if x]
        threshold = float(option(argv, "--min-security-severity", "7.0"))
        if not languages:
            print("No language CodeQL scans in this repo: nothing to check.")
            return 0
        files = sarif_files(argv[0])
        if len(files) < len(languages):
            found = ", ".join(os.path.basename(f) for f in files) or "none"
            raise Invalid(f"{len(languages)} language(s) scanned ({', '.join(languages)}) "
                          f"but {len(files)} SARIF file(s) found ({found})")
        findings = []
        for path in files:
            findings += list(blocking(load(path), threshold))
    except (Invalid, ValueError) as error:
        print(f"FAILED  {error}")
        return 1
    print(f"Read {', '.join(os.path.basename(f) for f in files)} for {', '.join(languages)}.")
    for rule_id, label, location in findings:
        print(f"BLOCKING  {rule_id}  ({label})  {location}")
    print(f"{len(findings)} blocking finding(s) at security-severity >= {threshold} or level error.")
    return 1 if findings else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
