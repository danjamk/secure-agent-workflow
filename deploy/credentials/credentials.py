#!/usr/bin/env python3
"""Operator credentials: store a checked value, and report on all of them (ADR-007).

    AWS_PROFILE=<profile> python3 deploy/credentials/credentials.py setup <owner>/<repo> [--dry-run] [--manifest FILE]
    AWS_PROFILE=<profile> python3 deploy/credentials/credentials.py set <owner>/<repo> <name> [--dry-run] [--manifest FILE]
    AWS_PROFILE=<profile> python3 deploy/credentials/credentials.py status <owner>/<repo> [--manifest FILE]
    python3 deploy/credentials/credentials.py check <owner>/<repo> [--issue] [--manifest FILE]

Usually run through `deploy/broker/aws/broker.sh setup|set|status`. Names follow
standards/credentials.md: each credential's dashboard name is
<repo>-<target>-<credential name>, and the tools print it.

setup   Walks through every declared credential that is missing, a placeholder
        or failing its check. For each one it prints where to create it, the
        name to give it, the permissions and the parameter path, then runs set's
        prompt and checks. Enter on an empty prompt skips one. Ends with status.
set     Reads the credential's entry from infra/credentials.yml on the repo's
        default branch, prompts for the value without echoing it, runs the
        system's checker, and stores the value in Parameter Store only if every
        check passes. Records the target account the checker reports as
        <system>-account-id, confirmed by the operator the first time and
        required to match after that. A value piped on stdin is read instead of
        prompting.
status  One line per check: the broker stacks, the roles' trust subjects, the
        environment secrets, then every declared credential (missing,
        placeholder, failing, expiring, overdue for rotation, unchecked) and
        every stored parameter the manifest doesn't declare. Exits 1 on any FAIL.
check   The daily job's status (#55), run by .github/workflows/credential-check.yml
        as the staging role: the dev target's credentials only, no broker
        checks. Masks every value it reads. --issue opens, updates or closes one
        issue labeled `credentials`; it opens one on any FAIL or any credential
        expiring within 14 days or past rotate_days. In GitHub Actions it uses
        the role's credentials from the environment instead of AWS_PROFILE.

--manifest reads a local file instead of the default branch, for trying a
manifest before it merges. Values are never printed. A human runs this, never
the agent. Standard library only; calls the aws and gh CLIs.
"""

import base64
import datetime as dt
import getpass
import hashlib
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

FIELDS = {"name", "system", "target", "exposure", "purpose", "permissions", "check", "rotate_days"}
REQUIRED = ("name", "system", "target", "exposure", "purpose")
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
        if not re.fullmatch(rf"{re.escape(e['system'])}-[a-z0-9-]+-(token|key|secret)", e["name"]):
            raise ValueError(f"{label}: name must be <system>-<role>-<kind>, such as {e['system']}-deploy-token; "
                             "kind is token, key or secret (standards/credentials.md)")
        if e["target"] not in EXPOSURES:
            raise ValueError(f"{label}: target must be dev or prod")
        if e["exposure"] not in EXPOSURES[e["target"]]:
            allowed = " or ".join(EXPOSURES[e["target"]])
            raise ValueError(f"{label}: exposure for the {e['target']} target must be {allowed}")
        if "rotate_days" in e:
            if not e["rotate_days"].isdigit() or int(e["rotate_days"]) < 1:
                raise ValueError(f"{label}: rotate_days must be a positive whole number")
            e["rotate_days"] = int(e["rotate_days"])
        e["check"] = e.get("check", "").split()
        key = (e["target"], e["name"])
        if key in seen:
            raise ValueError(f"{label}: declared twice for the {e['target']} target")
        seen.add(key)


def param_path(repo_name: str, e: dict) -> str:
    return f"/{repo_name}/{e['target']}/{e['exposure']}/{e['name']}"


def dashboard_name(repo_name: str, e: dict) -> str:
    """The name to give the token in the provider's dashboard (standards/credentials.md)."""
    return f"{repo_name}-{e['target']}-{e['name']}"


def identity_path(repo_name: str, system: str, target: str) -> str:
    return f"/{repo_name}/{target}/{IDENTITY_EXPOSURE[target]}/{system}-account-id"


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
    """Return [(level, message)] for one declared credential. Pure, for tests.
    Each message starts with the credential name and its dashboard name."""
    name = f"{e['name']} [{dashboard_name(repo.split('/')[-1], e)}]"
    if value is None:
        return [("FAIL", f"{name}: missing. Run: broker.sh setup {repo}")]
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
            out.append(("FAIL", f"{name}: belongs to {ident[1]}, not the {e['target']} target recorded for this repo"))
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
    """The value goes over stdin, so it never appears in a process list or a file.
    --value reads stdin once; --cli-input-json file:///dev/stdin reads it twice and
    gets nothing the second time (aws-cli 2.39)."""
    aws("ssm", "put-parameter", "--name", name, "--type", "SecureString" if secure else "String",
        "--overwrite", "--value", "file:///dev/stdin", stdin=value)


def tag_param(name: str, tags: dict) -> None:
    pairs = [{"Key": TAG + k, "Value": v} for k, v in tags.items()]
    aws("ssm", "add-tags-to-resource", "--resource-type", "Parameter", "--resource-id", name,
        "--tags", json.dumps(pairs))


def param_tags(name: str, strict: bool = False) -> dict:
    """The parameter's tags. strict raises when they can't be read, so the daily
    check never skips the rotation warning silently."""
    try:
        tags = aws("ssm", "list-tags-for-resource", "--resource-type", "Parameter", "--resource-id", name)
    except RuntimeError:
        if strict:
            raise
        return {}
    return {t["Key"]: t["Value"] for t in tags.get("TagList", [])}


def stored_names(path: str) -> list:
    """Every parameter name under path, e.g. /<repo> or /<repo>/dev/preview."""
    out = aws("ssm", "get-parameters-by-path", "--path", path, "--recursive",
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


def factory_identities() -> dict:
    """<SYSTEM>_ACCOUNT_ID from the environment or this repo's .env.local: the
    operator's factory accounts, where the platform runs. A target credential must
    never belong to one."""
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


def confirm(prompt: str, tty: str = "/dev/tty") -> bool:
    """Ask on the terminal, even when the value came in on stdin.
    Separate read and write handles: a terminal isn't seekable, so "r+" fails."""
    try:
        with open(tty, "w") as out, open(tty) as inp:
            out.write(prompt)
            out.flush()
            return inp.readline().strip() == "yes"
    except OSError as err:
        print(f"Can't ask on the terminal ({err}); taking that as no.")
        return False


def read_secret(name: str, allow_skip: bool = False) -> str:
    if sys.stdin.isatty():
        hint = "not echoed; Enter to skip" if allow_skip else "not echoed"
        return getpass.getpass(f"Paste {name} ({hint}): ").strip()
    return sys.stdin.read().strip()


def now_iso() -> str:
    return dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


# --- Commands ---

def describe(repo_name: str, e: dict) -> None:
    """Print what to create and where it goes (standards/credentials.md)."""
    print(f"  Create in:  your {e['target']} target's {e['system']} account")
    print(f"  Name it:    {dashboard_name(repo_name, e)}")
    if e.get("permissions"):
        print(f"  Grant:      {e['permissions']}")
    print(f"  Purpose:    {e['purpose']}")
    print(f"  Stored at:  {param_path(repo_name, e)}")
    if e["exposure"] == "preview":
        print("  Exposure:   preview. Code in any PR can read it, so use a test-mode or read-only credential.")


STORED, FAILED, SKIPPED = 0, 1, 2


def fingerprint(value: str) -> str:
    return hashlib.sha256(value.encode()).hexdigest()


def received(value: str) -> str:
    """Feedback after a hidden paste: length and the last 4 characters, never more."""
    tail = f", ending in {value[-4:]}" if len(value) >= 16 else ""
    return f"Received {len(value)} characters{tail}."


def paste_problem(value: str, name: str, seen: dict):
    """A reason to refuse a pasted value before checking it, or None. Pure, for tests."""
    if re.search(r"\s", value):
        return "the value contains spaces or line breaks; paste only the token"
    other = seen.get(fingerprint(value))
    if other and other != name:
        return f"same value as {other}; each credential needs its own token (standards/credentials.md)"
    return None


def store(repo: str, e: dict, dry_run: bool, allow_skip: bool = False, seen: dict = None) -> int:
    """Prompt for one credential's value, check it, and store it. Returns STORED, FAILED or SKIPPED.
    seen maps fingerprints of values already given or stored to their credential names."""
    repo_name = repo.split("/", 1)[1]
    path = param_path(repo_name, e)
    seen = {} if seen is None else seen
    value = read_secret(e["name"], allow_skip)
    if not value and allow_skip:
        print("Skipped.")
        return SKIPPED
    if not value or value == PLACEHOLDER:
        print("FAIL  empty or placeholder value; nothing stored")
        return FAILED
    print(received(value))
    problem = paste_problem(value, e["name"], seen)
    if problem:
        print(f"FAIL  {problem}. Nothing stored.")
        return FAILED
    seen[fingerprint(value)] = e["name"]

    check = run_checker(e["system"], e["check"], value)
    if check is None:
        print(f"WARN  no checker for {e['system']}; the value can't be checked")
        if not dry_run and not confirm("Store it unchecked? Type yes: "):
            print("Nothing stored.")
            return FAILED
    else:
        for kind, text in check["lines"]:
            print(f"{kind:<5} {text}")
        if check["expires"]:
            print(f"INFO  expires {check['expires']}")
        if check["fails"]:
            shown = {text for kind, text in check["lines"] if kind == "FAIL"}
            for reason in check["fails"]:
                if reason not in shown:
                    print(f"FAIL  {reason}")
            print("Nothing stored.")
            return FAILED

    ident = check["identity"] if check else None
    id_path = identity_path(repo_name, e["system"], e["target"])
    record_identity = False
    if ident:
        ident_id, label = ident
        factory_key = f"{e['system'].upper().replace('-', '_')}_ACCOUNT_ID"
        if factory_identities().get(factory_key) == ident_id:
            print(f"FAIL  {label} is your factory account ({factory_key}); target credentials never belong to it")
            return FAILED
        stored = get_param(id_path, decrypt=False)
        if stored and stored != PLACEHOLDER:
            if stored != ident_id:
                print(f"FAIL  {label} is not the {e['system']} {e['target']} target already recorded at {id_path}")
                return FAILED
            print(f"PASS  same {e['system']} account as the credentials already stored")
        else:
            record_identity = True
            if dry_run:
                print(f"INFO  first {e['system']} credential for this repo: you'd be asked to confirm {label}")
            elif not confirm(f"Is {label} ({ident_id}) your {e['system']} {e['target']} target for {repo}? Type yes: "):
                print("Nothing stored.")
                return FAILED

    if dry_run:
        print(f"Dry run: would store {path} (SecureString)"
              + (f" and record {id_path}" if record_identity else "") + ".")
        return STORED

    put_param(path, value, secure=True)
    caller = aws("sts", "get-caller-identity")["Arn"]
    tags = {"set-at": now_iso(), "set-by": caller, "checker": e["system"] if check else "none",
            "dashboard-name": dashboard_name(repo_name, e)}
    if check:
        tags["checked-at"] = tags["set-at"]
        tags["expires"] = str(check["expires"]) if check["expires"] else "none"
    tag_param(path, tags)
    print(f"Stored {path}.")
    if record_identity:
        put_param(id_path, ident[0], secure=False)
        tag_param(id_path, {"set-at": tags["set-at"], "set-by": caller})
        print(f"Recorded {id_path}.")
    return STORED


def cmd_set(repo: str, name: str, dry_run: bool, manifest_file) -> int:
    repo_name = repo.split("/", 1)[1]
    entries = load_manifest(repo, manifest_file)
    e = next((x for x in entries if x["name"] == name), None)
    if e is None:
        print(f"{name} is not declared in the manifest. Declared: {', '.join(x['name'] for x in entries)}")
        return 1
    print(f"\n{name}")
    describe(repo_name, e)
    return 0 if store(repo, e, dry_run) == STORED else 1


def cmd_setup(repo: str, dry_run: bool, manifest_file) -> int:
    """Walk through every declared credential that is missing or failing, then run status."""
    if not sys.stdin.isatty():
        print("setup needs a terminal. To pipe a value, use: broker.sh set <owner>/<repo> <name>")
        return 1
    repo_name = repo.split("/", 1)[1]
    entries = load_manifest(repo, manifest_file)
    todo, seen = [], {}
    for e in entries:
        label = f"{e['name']} [{dashboard_name(repo_name, e)}]"
        value = get_param(param_path(repo_name, e), decrypt=True)
        if value and value != PLACEHOLDER:
            seen[fingerprint(value)] = e["name"]
        if value is None:
            todo.append((e, "missing"))
        elif value == PLACEHOLDER:
            todo.append((e, "placeholder"))
        else:
            check = run_checker(e["system"], e["check"], value)
            if check is None:
                print(f"WARN  {label}: stored; no checker, so left as is")
            elif check["fails"]:
                todo.append((e, f"check fails: {check['fails'][0]}"))
            else:
                print(f"PASS  {label}: stored and passing")
    if not todo:
        print("Every declared credential is stored and passing.")
    else:
        print(f"\n{len(todo)} to set up. For each: create it in the dashboard with the name shown, "
              "then paste it here. Press Enter on an empty prompt to skip one.")
    counts = {STORED: 0, FAILED: 0, SKIPPED: 0}
    for i, (e, reason) in enumerate(todo, 1):
        print(f"\n[{i}/{len(todo)}] {e['name']} ({reason})")
        describe(repo_name, e)
        try:
            counts[store(repo, e, dry_run, allow_skip=True, seen=seen)] += 1
        except RuntimeError as err:
            print(f"FAIL  {err}")
            counts[FAILED] += 1
    if todo:
        print(f"\n{counts[STORED]} stored, {counts[SKIPPED]} skipped, {counts[FAILED]} failed. "
              "Run setup again to pick up the rest.")
    if dry_run:
        return 0
    print()
    return cmd_status(repo, manifest_file)


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
        id_path = identity_path(repo_name, e["system"], e["target"])
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

    for name in stored_names(f"/{repo_name}"):
        if name not in declared and name not in identities:
            emit([("WARN", f"{name}: stored but not declared in the manifest")])

    counts = {lvl: sum(1 for level, _ in results if level == lvl) for lvl in ("PASS", "WARN", "FAIL")}
    print(f"\n{counts['PASS']} pass, {counts['WARN']} warn, {counts['FAIL']} fail")
    return 1 if counts["FAIL"] else 0


# --- Daily check (#55) ---

# The daily check runs as the staging role, which reads the dev target's preview
# and staging exposures only. Prod credentials stay with status until the prod
# role exists (ADR-007).
CHECK_TARGET = "dev"
ISSUE_LABEL = "credentials"
ISSUE_MARKER = "<!-- saw-credential-check -->"
# WARN lines that open the issue: expiring soon or past rotate_days. Other WARNs
# (no checker, stored but undeclared) are listed but don't open it on their own.
ATTENTION_WARN = re.compile(r": (expires \S+, in \d+ days|set \d+ days ago; rotate every \d+)$")
AWS_ACCOUNT = re.compile(r"\b\d{12}\b")


def needs_attention(results: list) -> list:
    """The FAIL lines and the expiry and rotation WARN lines. Pure, for tests."""
    return [(lvl, msg) for lvl, msg in results
            if lvl == "FAIL" or (lvl == "WARN" and ATTENTION_WARN.search(msg))]


def sanitize(text: str, private: set) -> str:
    """Remove account names and IDs before text goes into an issue, which is
    public on a public repo. AWS account IDs too: they appear in AWS errors."""
    for item in sorted(private, key=len, reverse=True):
        if item:
            text = text.replace(item, "[account]")
    return AWS_ACCOUNT.sub("[aws-account]", text)


def problems_key(attention: list) -> str:
    """A fingerprint of what's wrong, ignoring day counts, so the issue gets a
    comment when the problems change and not every day."""
    norm = sorted(re.sub(r"\d+ days", "N days", f"{lvl} {msg}") for lvl, msg in attention)
    return fingerprint("\n".join(norm))[:16]


def issue_body(repo: str, results: list, attention: list, run_url: str, today: dt.date) -> str:
    """The issue's body: what needs attention, then everything else. Pure, for tests."""
    others = [r for r in results if r not in attention]
    lines = [
        ISSUE_MARKER,
        f"The daily credential check found {len(attention)} to fix in `{repo}`. "
        f"Last checked {today.isoformat()}" + (f" ([run]({run_url}))." if run_url else "."),
        "",
        "## Needs attention",
        "",
        *[f"- **{lvl}** {msg}" for lvl, msg in attention],
        "",
        "## Everything else",
        "",
        *([f"- {lvl} {msg}" for lvl, msg in others] or ["- Nothing else checked."]),
        "",
        "## How to fix",
        "",
        f"Run `AWS_PROFILE=<profile> bash deploy/broker/aws/broker.sh setup {repo}` from "
        "secure-agent-workflow. It asks only for what is missing or failing, and names the "
        "token to create in the dashboard (`standards/credentials.md`).",
        "",
        "This issue is updated by each daily run and closes itself when every credential passes. "
        "Prod credentials aren't checked here; run `broker.sh status` for those.",
        "",
        f"<!-- saw-problems: {problems_key(attention)} -->",
    ]
    return "\n".join(lines) + "\n"


def file_issue(repo: str, results: list, run_url: str, today: dt.date, private: set) -> None:
    """Open, update or close the one open issue labeled `credentials`."""
    attention = [(lvl, sanitize(msg, private)) for lvl, msg in needs_attention(results)]
    clean = [(lvl, sanitize(msg, private)) for lvl, msg in results]
    found = json.loads(gh("issue", "list", "--repo", repo, "--label", ISSUE_LABEL, "--state", "open",
                          "--json", "number,body", "--limit", "20") or "[]")
    found = [i for i in found if ISSUE_MARKER in (i.get("body") or "")]
    number = found[0]["number"] if found else None
    link = f" ({run_url})" if run_url else ""

    if not attention:
        if number:
            gh("issue", "close", str(number), "--repo", repo,
               "--comment", f"Every credential passes as of {today.isoformat()}{link}.")
            print(f"Closed issue #{number}: every credential passes.")
        else:
            print("Every credential passes; no issue to open.")
        return

    fails = sum(1 for lvl, _ in attention if lvl == "FAIL")
    warns = len(attention) - fails
    title = f"Credentials: {fails} failing, {warns} expiring or due for rotation"
    body = issue_body(repo, clean, attention, run_url, today)
    if number is None:
        # bootstrap creates the label; a repo bootstrapped before #55 may lack it.
        sh(["gh", "label", "create", ISSUE_LABEL, "--repo", repo, "--color", "d93f0b",
            "--description", "A stored credential is failing, expiring or due for rotation"])
        proc = sh(["gh", "issue", "create", "--repo", repo, "--label", ISSUE_LABEL,
                   "--title", title, "--body-file", "-"], stdin=body)
        if proc.returncode != 0:
            raise RuntimeError(proc.stderr.strip() or "gh issue create failed")
        print(f"Opened {proc.stdout.strip()}")
        return
    old_key = re.search(r"saw-problems: (\w+)", found[0]["body"] or "")
    proc = sh(["gh", "issue", "edit", str(number), "--repo", repo, "--title", title,
               "--body-file", "-"], stdin=body)
    if proc.returncode != 0:
        raise RuntimeError(proc.stderr.strip() or "gh issue edit failed")
    if not old_key or old_key.group(1) != problems_key(attention):
        gh("issue", "comment", str(number), "--repo", repo,
           "--body", f"The problems changed{link}:\n\n" + "\n".join(f"- **{l}** {m}" for l, m in attention))
        print(f"Updated issue #{number}: the problems changed.")
    else:
        print(f"Updated issue #{number}: same problems.")


def mask(value) -> None:
    """Hide a value from the GitHub Actions log, one line at a time."""
    if value and os.environ.get("GITHUB_ACTIONS") == "true":
        for line in str(value).splitlines():
            if line.strip():
                print(f"::add-mask::{line}")


def cmd_check(repo: str, manifest_file, issue: bool) -> int:
    """status for the daily job: the dev target's credentials only, no broker
    checks (the staging role can't read them), and the result filed as an issue."""
    repo_name = repo.split("/", 1)[1]
    today = dt.datetime.now(dt.timezone.utc).date()
    results, private = [], set()

    def emit(items):
        for level, msg in items:
            print(f"{level:<5} {msg}")
        results.extend(items)

    try:
        mask(aws("sts", "get-caller-identity")["Account"])
        entries = load_manifest(repo, manifest_file)
    except (RuntimeError, ValueError) as err:
        entries = None
        emit([("FAIL", f"manifest or AWS: {err}")])

    skipped = [e["name"] for e in entries or [] if e["target"] != CHECK_TARGET]
    if skipped:
        print(f"INFO  not checked here (prod target): {', '.join(skipped)}")
    declared, identities = set(), {}
    for e in entries or []:
        if e["target"] != CHECK_TARGET:
            continue
        path = param_path(repo_name, e)
        declared.add(path)
        id_path = identity_path(repo_name, e["system"], e["target"])
        try:
            if id_path not in identities:
                identities[id_path] = get_param(id_path, decrypt=False)
                mask(identities[id_path])
                private.add(identities[id_path] or "")
            value = get_param(path, decrypt=True)
            mask(value)
            check = None
            if value not in (None, PLACEHOLDER):
                check = run_checker(e["system"], e["check"], value)
            if check and check["identity"]:
                mask(check["identity"][0])
                mask(check["identity"][1])
                private.update(check["identity"])
            stored_identity = identities[id_path]
            if stored_identity == PLACEHOLDER:
                stored_identity = None
            tags = param_tags(path, strict=True) if value is not None else {}
            emit(evaluate(e, value, check, tags, stored_identity, today, repo))
        except RuntimeError as err:
            emit([("FAIL", f"{e['name']}: can't read it as the staging role: {err}")])

    if entries is not None:
        for exposure in EXPOSURES[CHECK_TARGET]:
            try:
                names = stored_names(f"/{repo_name}/{CHECK_TARGET}/{exposure}")
            except RuntimeError as err:
                emit([("FAIL", f"can't list /{repo_name}/{CHECK_TARGET}/{exposure}: {err}")])
                continue
            for name in names:
                if name not in declared and name not in identities:
                    emit([("WARN", f"{name}: stored but not declared in the manifest")])

    counts = {lvl: sum(1 for level, _ in results if level == lvl) for lvl in ("PASS", "WARN", "FAIL")}
    print(f"\n{counts['PASS']} pass, {counts['WARN']} warn, {counts['FAIL']} fail")
    if not issue:
        return 1 if counts["FAIL"] else 0
    server, run_id = os.environ.get("GITHUB_SERVER_URL"), os.environ.get("GITHUB_RUN_ID")
    run_url = f"{server}/{os.environ.get('GITHUB_REPOSITORY', repo)}/actions/runs/{run_id}" if run_id else ""
    file_issue(repo, results, run_url, today, private)
    # The issue is the signal. The job fails only if the issue couldn't be filed.
    return 0


def main(argv: list) -> int:
    usage = ("usage: credentials.py setup <owner>/<repo> [--dry-run] [--manifest FILE]\n"
             "       credentials.py set <owner>/<repo> <name> [--dry-run] [--manifest FILE]\n"
             "       credentials.py status <owner>/<repo> [--manifest FILE]\n"
             "       credentials.py check <owner>/<repo> [--issue] [--manifest FILE]")
    args, dry_run, manifest, issue = [], False, None, False
    it = iter(argv)
    for arg in it:
        if arg == "--dry-run":
            dry_run = True
        elif arg == "--issue":
            issue = True
        elif arg == "--manifest":
            manifest = next(it, None)
        elif arg.startswith("-"):
            print(f"Unknown flag: {arg}\n{usage}")
            return 1
        else:
            args.append(arg)
    if not args or args[0] not in ("setup", "set", "status", "check") or len(args) < 2 \
            or not re.fullmatch(r"[A-Za-z0-9-]+/[A-Za-z0-9._-]+", args[1]):
        print(usage)
        return 1
    if args[0] == "check" and os.environ.get("GITHUB_ACTIONS") == "true":
        # The daily job: credentials come from the staging role, set in the environment.
        try:
            return cmd_check(args[1], manifest, issue)
        except RuntimeError as err:
            print(f"FAIL  {sanitize(str(err), set())}")
            return 1
    if not os.environ.get("AWS_PROFILE"):
        print("Set AWS_PROFILE. This never uses default credentials.")
        return 1
    try:
        print(f"AWS: {aws('sts', 'get-caller-identity')['Arn']}, {REGION} (profile {os.environ['AWS_PROFILE']})")
        if args[0] == "check":
            return cmd_check(args[1], manifest, issue)
        if args[0] == "set":
            if len(args) != 3:
                print(usage)
                return 1
            return cmd_set(args[1], args[2], dry_run, manifest)
        if args[0] == "setup":
            return cmd_setup(args[1], dry_run, manifest)
        return cmd_status(args[1], manifest)
    except (RuntimeError, ValueError) as err:
        print(f"FAIL  {err}")
        return 1


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
