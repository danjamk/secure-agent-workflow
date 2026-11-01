#!/usr/bin/env python3
"""Operator credentials: store a checked value, and report on all of them (ADR-007).

    AWS_PROFILE=<profile> python3 deploy/credentials/credentials.py set <owner>/<repo> <name> [--dry-run] [--manifest FILE]
    AWS_PROFILE=<profile> python3 deploy/credentials/credentials.py status <owner>/<repo> [--manifest FILE]

Usually run through `deploy/broker/aws/broker.sh set|status`.

set     Reads the credential's entry from infra/credentials.yml on the repo's
        default branch, prompts for the value without echoing it, runs the
        system's checker, and stores the value in Parameter Store only if every
        check passes. Records the account the checker reports as
        <system>-account-id, confirmed by the operator the first time and
        required to match after that. A value piped on stdin is read instead of
        prompting.
status  One line per check: the broker stacks, the roles' trust subjects, the
        environment secrets, then every declared credential (missing,
        placeholder, failing, expiring, overdue for rotation, unchecked) and
        every stored parameter the manifest doesn't declare. Exits 1 on any FAIL.

--manifest reads a local file instead of the default branch, for trying a
manifest before it merges. Values are never printed. A human runs this, never
the agent. Standard library only; calls the aws and gh CLIs.
"""

import base64
import datetime as dt
import getpass
import json
import os
import re
import subprocess
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
CHECKS = HERE / "checks"
REPO_ROOT = HERE.parent.parent
MANIFEST_PATH = "infra/credentials.yml"
REGION = os.environ.get("AWS_REGION", "us-east-1")

FIELDS = {"name", "system", "account", "exposure", "purpose", "permissions", "check", "rotate_days"}
REQUIRED = ("name", "system", "account", "exposure", "purpose")
EXPOSURES = {"dev": ("preview", "staging"), "prod": ("prod",)}
IDENTITY_EXPOSURE = {"dev": "preview", "prod": "prod"}  # where <system>-account-id lives
PLACEHOLDER = "placeholder"
EXPIRY_WARN_DAYS = 14
TAG = "saw:"


# --- Manifest ---

def _scalar(raw: str) -> str:
    """A YAML scalar from the manifest's flat shape: optional quotes, optional comment."""
    raw = raw.strip()
    if raw[:1] in "\"'":
        end = raw.find(raw[0], 1)
        if end < 0:
            raise ValueError(f"unclosed quote in {raw!r}")
        return raw[1:end]
    return re.split(r"\s+#", raw, maxsplit=1)[0].strip()


def parse_manifest(text: str) -> list:
    """Parse infra/credentials.yml's one accepted shape into a list of entries.

    A full YAML parser would need a dependency. The shape is fixed, so anything
    outside it is an error rather than a guess.
    """
    entries: list = []
    seen_root = False
    for number, raw in enumerate(text.splitlines(), 1):
        line = raw.rstrip()
        stripped = line.strip()
        if not stripped or stripped.startswith("#"):
            continue
        if not seen_root:
            if line != "credentials:":
                raise ValueError(f"line {number}: expected 'credentials:'")
            seen_root = True
            continue
        item = re.fullmatch(r"\s+-\s+([a-z_]+):(.*)", line)
        field = re.fullmatch(r"\s+([a-z_]+):(.*)", line)
        if item:
            entries.append({})
            key, value = item.groups()
        elif field and entries:
            key, value = field.groups()
        else:
            raise ValueError(f"line {number}: unexpected {stripped!r}")
        if key not in FIELDS:
            raise ValueError(f"line {number}: unknown field {key!r}")
        if key in entries[-1]:
            raise ValueError(f"line {number}: {key!r} given twice")
        entries[-1][key] = _scalar(value)
    if not seen_root:
        raise ValueError("empty manifest")
    validate(entries)
    return entries


def validate(entries: list) -> None:
    seen = set()
    for e in entries:
        label = e.get("name", "an entry")
        for key in REQUIRED:
            if not e.get(key):
                raise ValueError(f"{label}: missing {key!r}")
        if not re.fullmatch(r"[a-z0-9][a-z0-9-]*", e["name"]):
            raise ValueError(f"{label}: name must be lowercase letters, digits and hyphens")
        if e["name"].endswith("-account-id"):
            raise ValueError(f"{label}: names ending in -account-id are reserved for checker identities")
        if not re.fullmatch(r"[a-z0-9][a-z0-9-]*", e["system"]):
            raise ValueError(f"{label}: system must be lowercase letters, digits and hyphens")
        if e["account"] not in EXPOSURES:
            raise ValueError(f"{label}: account must be dev or prod")
        if e["exposure"] not in EXPOSURES[e["account"]]:
            allowed = " or ".join(EXPOSURES[e["account"]])
            raise ValueError(f"{label}: exposure for the {e['account']} account must be {allowed}")
        if "rotate_days" in e:
            if not e["rotate_days"].isdigit() or int(e["rotate_days"]) < 1:
                raise ValueError(f"{label}: rotate_days must be a positive whole number")
            e["rotate_days"] = int(e["rotate_days"])
        e["check"] = e.get("check", "").split()
        key = (e["account"], e["name"])
        if key in seen:
            raise ValueError(f"{label}: declared twice for the {e['account']} account")
        seen.add(key)


def param_path(repo_name: str, e: dict) -> str:
    return f"/{repo_name}/{e['account']}/{e['exposure']}/{e['name']}"


def identity_path(repo_name: str, system: str, account: str) -> str:
    return f"/{repo_name}/{account}/{IDENTITY_EXPOSURE[account]}/{system}-account-id"


# --- Checker output ---

def parse_check(stdout: str, returncode: int) -> dict:
    """Read a checker's PASS/FAIL/INFO/EXPIRES/IDENTITY lines."""
    result = {"lines": [], "fails": [], "expires": None, "identity": None}
    for line in stdout.splitlines():
        kind, _, rest = line.strip().partition(" ")
        if kind == "EXPIRES":
            result["expires"] = dt.date.fromisoformat(rest.strip()[:10])
        elif kind == "IDENTITY":
            ident, _, label = rest.strip().partition(" ")
            result["identity"] = (ident, label or ident)
        elif kind in ("PASS", "FAIL", "INFO"):
            result["lines"].append((kind, rest.strip()))
            if kind == "FAIL":
                result["fails"].append(rest.strip())
    if returncode != 0 and not result["fails"]:
        result["fails"].append(f"checker exited {returncode}")
    return result


def run_checker(system: str, words: list, value: str):
    """Run checks/<system>. Returns the parsed result, or None if there is no checker."""
    checker = CHECKS / system
    if not checker.is_file():
        return None
    proc = subprocess.run([str(checker), *words], input=value, capture_output=True, text=True, timeout=120)
    if value and (value in proc.stdout or value in proc.stderr):
        return {"lines": [], "fails": ["checker printed the secret; output discarded"],
                "expires": None, "identity": None}
    return parse_check(proc.stdout, proc.returncode)


# --- Status of one credential ---

def evaluate(e: dict, value, check, tags: dict, stored_identity, today: dt.date, repo="<repo>") -> list:
    """Return [(level, message)] for one declared credential. Pure, for tests."""
    name = e["name"]
    if value is None:
        return [("FAIL", f"{name}: missing. Run: broker.sh set {repo} {name}")]
    if value == PLACEHOLDER:
        return [("FAIL", f"{name}: still a placeholder")]
    out = []
    if check is None:
        out.append(("WARN", f"{name}: unchecked (no checker for {e['system']})"))
    elif check["fails"]:
        out.append(("FAIL", f"{name}: check fails: {check['fails'][0]}"))
    else:
        ident = check["identity"]
        if ident and stored_identity and ident[0] != stored_identity:
            out.append(("FAIL", f"{name}: belongs to {ident[1]}, not the account recorded for this repo"))
        expires = check["expires"]
        if expires and expires <= today:
            out.append(("FAIL", f"{name}: expired {expires}"))
        elif expires and (expires - today).days <= EXPIRY_WARN_DAYS:
            out.append(("WARN", f"{name}: expires {expires}, in {(expires - today).days} days"))
    set_at = tags.get(TAG + "set-at", "")[:10]
    if e.get("rotate_days") and set_at:
        age = (today - dt.date.fromisoformat(set_at)).days
        if age > e["rotate_days"]:
            out.append(("WARN", f"{name}: set {age} days ago; rotate every {e['rotate_days']}"))
    if not any(level == "FAIL" for level, _ in out) and check is not None:
        detail = [f"expires {check['expires']}" if check["expires"] else "no expiry"]
        if set_at:
            detail.append(f"set {set_at}")
        out.insert(0, ("PASS", f"{name}: checks pass; {', '.join(detail)}"))
    return out


# --- AWS and GitHub ---

def sh(cmd: list, stdin=None) -> subprocess.CompletedProcess:
    return subprocess.run(cmd, input=stdin, capture_output=True, text=True)


def aws(*args, stdin=None):
    """Run an aws command; returns parsed JSON (or None for empty output). Raises on error."""
    proc = sh(["aws", "--region", REGION, "--output", "json", *args], stdin)
    if proc.returncode != 0:
        raise RuntimeError(proc.stderr.strip() or f"aws {args[0]} failed")
    return json.loads(proc.stdout) if proc.stdout.strip() else None


def gh(*args) -> str:
    proc = sh(["gh", *args])
    if proc.returncode != 0:
        raise RuntimeError(proc.stderr.strip() or "gh failed")
    return proc.stdout


def get_param(name: str, decrypt: bool):
    try:
        args = ["ssm", "get-parameter", "--name", name]
        if decrypt:
            args.append("--with-decryption")
        return aws(*args)["Parameter"]["Value"]
    except RuntimeError as err:
        if "ParameterNotFound" in str(err):
            return None
        raise


def put_param(name: str, value: str, secure: bool) -> None:
    """The value goes over stdin, so it never appears in a process list."""
    spec = {"Name": name, "Value": value, "Type": "SecureString" if secure else "String", "Overwrite": True}
    aws("ssm", "put-parameter", "--cli-input-json", "file:///dev/stdin", stdin=json.dumps(spec))


def tag_param(name: str, tags: dict) -> None:
    pairs = [{"Key": TAG + k, "Value": v} for k, v in tags.items()]
    aws("ssm", "add-tags-to-resource", "--resource-type", "Parameter", "--resource-id", name,
        "--tags", json.dumps(pairs))


def param_tags(name: str) -> dict:
    try:
        tags = aws("ssm", "list-tags-for-resource", "--resource-type", "Parameter", "--resource-id", name)
    except RuntimeError:
        return {}
    return {t["Key"]: t["Value"] for t in tags.get("TagList", [])}


def stored_names(repo_name: str) -> list:
    out = aws("ssm", "get-parameters-by-path", "--path", f"/{repo_name}", "--recursive",
              "--query", "Parameters[].Name")
    return out or []


def load_manifest(repo: str, local_file) -> list:
    if local_file:
        print(f"Manifest: {local_file} (local file, not the default branch)")
        return parse_manifest(Path(local_file).read_text())
    try:
        content = gh("api", f"repos/{repo}/contents/{MANIFEST_PATH}", "--jq", ".content")
    except RuntimeError as err:
        raise RuntimeError(f"no {MANIFEST_PATH} on {repo}'s default branch ({err})") from None
    print(f"Manifest: {MANIFEST_PATH} on {repo}'s default branch")
    return parse_manifest(base64.b64decode(content).decode())


def tooling_identities() -> dict:
    """<SYSTEM>_ACCOUNT_ID from the environment or this repo's .env.local: the
    operator's tooling accounts, which a consumer credential must never belong to."""
    values = {}
    env_file = REPO_ROOT / ".env.local"
    if env_file.is_file():
        for line in env_file.read_text().splitlines():
            m = re.fullmatch(r"\s*(?:export\s+)?([A-Z0-9_]+_ACCOUNT_ID)\s*=\s*['\"]?([^'\"#\s]*)", line)
            if m and m.group(2):
                values[m.group(1)] = m.group(2)
    for key, value in os.environ.items():
        if key.endswith("_ACCOUNT_ID") and value:
            values[key] = value
    return values


def confirm(prompt: str) -> bool:
    """Ask on the terminal, even when the value came in on stdin."""
    try:
        with open("/dev/tty", "r+") as tty:
            tty.write(prompt)
            tty.flush()
            return tty.readline().strip() == "yes"
    except OSError:
        return False


def read_secret(name: str) -> str:
    if sys.stdin.isatty():
        return getpass.getpass(f"Value for {name} (not echoed): ").strip()
    return sys.stdin.read().strip()


def now_iso() -> str:
    return dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


# --- Commands ---

def cmd_set(repo: str, name: str, dry_run: bool, manifest_file) -> int:
    repo_name = repo.split("/", 1)[1]
    entries = load_manifest(repo, manifest_file)
    e = next((x for x in entries if x["name"] == name), None)
    if e is None:
        print(f"{name} is not declared in the manifest. Declared: {', '.join(x['name'] for x in entries)}")
        return 1
    path = param_path(repo_name, e)
    print(f"Credential: {name} -> {path}")
    print(f"  Purpose: {e['purpose']}")
    if e.get("permissions"):
        print(f"  Create it with: {e['permissions']}")
    if e["exposure"] == "preview":
        print("  Exposure preview: code in any PR can read it. Use a test-mode or read-only credential.")

    value = read_secret(name)
    if not value or value == PLACEHOLDER:
        print("FAIL  empty or placeholder value; nothing stored")
        return 1

    check = run_checker(e["system"], e["check"], value)
    if check is None:
        print(f"WARN  no checker for {e['system']}; the value can't be checked")
        if not dry_run and not confirm("Store it unchecked? Type yes: "):
            print("Nothing stored.")
            return 1
    else:
        for kind, text in check["lines"]:
            print(f"{kind:<5} {text}")
        if check["expires"]:
            print(f"INFO  expires {check['expires']}")
        if check["fails"]:
            print("Nothing stored.")
            return 1

    ident = check["identity"] if check else None
    id_path = identity_path(repo_name, e["system"], e["account"])
    record_identity = False
    if ident:
        ident_id, label = ident
        tooling_key = f"{e['system'].upper().replace('-', '_')}_ACCOUNT_ID"
        if tooling_identities().get(tooling_key) == ident_id:
            print(f"FAIL  {label} is your tooling account ({tooling_key}); consumer credentials never belong to it")
            return 1
        stored = get_param(id_path, decrypt=False)
        if stored and stored != PLACEHOLDER:
            if stored != ident_id:
                print(f"FAIL  {label} is not the {e['account']} account already recorded at {id_path}")
                return 1
            print(f"PASS  same {e['system']} account as the credentials already stored")
        else:
            record_identity = True
            if dry_run:
                print(f"INFO  first {e['system']} credential for this repo: you'd be asked to confirm {label}")
            elif not confirm(f"Is {label} ({ident_id}) the {e['account']} account for {repo}? Type yes: "):
                print("Nothing stored.")
                return 1

    if dry_run:
        print(f"Dry run: would store {path} (SecureString)"
              + (f" and record {id_path}" if record_identity else "") + ".")
        return 0

    put_param(path, value, secure=True)
    caller = aws("sts", "get-caller-identity")["Arn"]
    tags = {"set-at": now_iso(), "set-by": caller, "checker": e["system"] if check else "none"}
    if check:
        tags["checked-at"] = tags["set-at"]
        tags["expires"] = str(check["expires"]) if check["expires"] else "none"
    tag_param(path, tags)
    print(f"Stored {path}.")
    if record_identity:
        put_param(id_path, ident[0], secure=False)
        tag_param(id_path, {"set-at": tags["set-at"], "set-by": caller})
        print(f"Recorded {id_path}.")
    return 0


def broker_checks(repo: str, repo_name: str) -> list:
    out = []
    stack = "saw-broker-" + re.sub(r"[^A-Za-z0-9-]", "-", repo_name)
    for name in ("saw-broker", stack):
        try:
            status = aws("cloudformation", "describe-stacks", "--stack-name", name,
                         "--query", "Stacks[0].StackStatus")
            level = "PASS" if status.endswith("_COMPLETE") and "ROLLBACK" not in status else "FAIL"
            out.append((level, f"stack {name}: {status}"))
        except RuntimeError:
            out.append(("FAIL", f"stack {name}: not found"))
    owner = repo.split("/", 1)[0]
    owner_id, repo_id = gh("api", f"repos/{repo}", "--jq", '"\\(.owner.id) \\(.id)"').split()
    for env in ("preview", "staging"):
        want = f"repo:{owner}@{owner_id}/{repo_name}@{repo_id}:environment:{env}"
        try:
            doc = aws("iam", "get-role", "--role-name", f"saw-{repo_name}-{env}",
                      "--query", "Role.AssumeRolePolicyDocument")
            subs = [s.get("Condition", {}).get("StringEquals", {}).get("token.actions.githubusercontent.com:sub")
                    for s in doc.get("Statement", [])]
            out.append(("PASS", f"role saw-{repo_name}-{env} trusts only {env}") if subs == [want]
                       else ("FAIL", f"role saw-{repo_name}-{env} trusts {subs}, want {want}"))
        except RuntimeError:
            out.append(("FAIL", f"role saw-{repo_name}-{env}: not found"))
        try:
            names = gh("api", f"repos/{repo}/environments/{env}/secrets", "--jq", ".secrets[].name").split()
        except RuntimeError:
            names = []
        out.append(("PASS", f"environment {env} has AWS_ROLE_ARN") if "AWS_ROLE_ARN" in names
                   else ("FAIL", f"environment {env} has no AWS_ROLE_ARN. Run: broker.sh add-repo {repo}"))
    return out


def cmd_status(repo: str, manifest_file) -> int:
    repo_name = repo.split("/", 1)[1]
    today = dt.datetime.now(dt.timezone.utc).date()
    results = []

    def emit(items):
        for level, msg in items:
            print(f"{level:<5} {msg}")
        results.extend(items)

    print("Broker")
    emit(broker_checks(repo, repo_name))

    print("\nCredentials")
    try:
        entries = load_manifest(repo, manifest_file)
    except (RuntimeError, ValueError) as err:
        emit([("FAIL", f"manifest: {err}")])
        entries = []

    declared, identities, unrecorded = set(), {}, set()
    for e in entries:
        path = param_path(repo_name, e)
        declared.add(path)
        id_path = identity_path(repo_name, e["system"], e["account"])
        if id_path not in identities:
            identities[id_path] = get_param(id_path, decrypt=False)
        value = get_param(path, decrypt=True)
        check = None
        if value not in (None, PLACEHOLDER):
            check = run_checker(e["system"], e["check"], value)
        stored_identity = identities[id_path]
        if stored_identity == PLACEHOLDER:
            stored_identity = None
        emit(evaluate(e, value, check, param_tags(path) if value is not None else {},
                      stored_identity, today, repo))
        if check and check["identity"] and not stored_identity and id_path not in unrecorded:
            unrecorded.add(id_path)
            emit([("FAIL", f"{e['system']}-account-id: not recorded at {id_path}. "
                           f"Store a {e['system']} credential with broker.sh set")])

    for name in stored_names(repo_name):
        if name not in declared and name not in identities:
            emit([("WARN", f"{name}: stored but not declared in the manifest")])

    counts = {lvl: sum(1 for level, _ in results if level == lvl) for lvl in ("PASS", "WARN", "FAIL")}
    print(f"\n{counts['PASS']} pass, {counts['WARN']} warn, {counts['FAIL']} fail")
    return 1 if counts["FAIL"] else 0


def main(argv: list) -> int:
    usage = ("usage: credentials.py set <owner>/<repo> <name> [--dry-run] [--manifest FILE]\n"
             "       credentials.py status <owner>/<repo> [--manifest FILE]")
    args, dry_run, manifest = [], False, None
    it = iter(argv)
    for arg in it:
        if arg == "--dry-run":
            dry_run = True
        elif arg == "--manifest":
            manifest = next(it, None)
        elif arg.startswith("-"):
            print(f"Unknown flag: {arg}\n{usage}")
            return 1
        else:
            args.append(arg)
    if not args or args[0] not in ("set", "status") or len(args) < 2 \
            or not re.fullmatch(r"[A-Za-z0-9-]+/[A-Za-z0-9._-]+", args[1]):
        print(usage)
        return 1
    if not os.environ.get("AWS_PROFILE"):
        print("Set AWS_PROFILE. This never uses default credentials.")
        return 1
    try:
        print(f"AWS: {aws('sts', 'get-caller-identity')['Arn']}, {REGION} (profile {os.environ['AWS_PROFILE']})")
        if args[0] == "set":
            if len(args) != 3:
                print(usage)
                return 1
            return cmd_set(args[1], args[2], dry_run, manifest)
        return cmd_status(args[1], manifest)
    except (RuntimeError, ValueError) as err:
        print(f"FAIL  {err}")
        return 1


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
