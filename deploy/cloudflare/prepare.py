#!/usr/bin/env python3
"""Check and unpack the build job's bundle, and write the config the deploy job uses (#18).

The deploy job holds a Cloudflare token, so it runs nothing from the consumer
repo. The bundle and the wrangler config both come from the PR, so this script
treats them as untrusted input:

- the bundle's sha256 must match the build job's output;
- only regular files under dist/, plus the config and package.json, are
  unpacked; links, devices, absolute paths and `..` are refused;
- the config's [build] section is removed, because wrangler runs
  build.command even with --no-bundle (checked with wrangler 4.151.1), and
  account_id is removed, because the broker decides the account;
- containers, Workers Sites and static assets are refused: each needs files
  or tools from outside the bundle.

Writes <out>/dist/..., <out>/wrangler.json and <out>/build-id.

    prepare.py --bundle B --digest D --config NAME --env preview|staging --sha SHA --out DIR
"""

import argparse
import hashlib
import json
import os
import re
import sys
import tarfile
import tomllib

ENTRY = "dist/index.js"
MAX_BYTES = 100 * 1024 * 1024
CONFIG_NAMES = ("wrangler.jsonc", "wrangler.json", "wrangler.toml")
STRIP = {
    "build": "custom build commands run only in the build job (make build)",
    "account_id": "the broker sets the account",
}
REFUSE = {
    "containers": "container images are built from the repo, which the deploy job doesn't run",
    "site": "Workers Sites read files outside the bundle",
    "assets": "static assets aren't supported by the deploy template yet",
}
VERSION = re.compile(r"^[0-9A-Za-z.-]{1,32}$")


class Refused(Exception):
    pass


def sha256(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def safe_name(name, config):
    """The member name if it may be unpacked, else None."""
    norm = os.path.normpath(name)
    if os.path.isabs(name) or norm.startswith("..") or "\\" in name:
        return None
    if norm in (config, "package.json") or norm == "dist" or norm.startswith("dist/"):
        return norm
    return None


def unpack(bundle, config, out):
    total = 0
    with tarfile.open(bundle, "r:gz") as tar:
        for m in tar.getmembers():
            name = safe_name(m.name, config)
            if name is None:
                raise Refused(f"bundle member '{m.name}' is outside dist/, the config and package.json")
            if m.isdir():
                os.makedirs(os.path.join(out, name), exist_ok=True)
                continue
            if not m.isfile():
                raise Refused(f"bundle member '{m.name}' isn't a regular file (links aren't allowed)")
            total += m.size
            if total > MAX_BYTES:
                raise Refused(f"bundle is over {MAX_BYTES // (1024 * 1024)} MB unpacked")
            dest = os.path.join(out, name)
            os.makedirs(os.path.dirname(dest), exist_ok=True)
            src = tar.extractfile(m)
            with open(dest, "wb") as f:
                f.write(src.read())
            os.chmod(dest, 0o644)
    if not os.path.isfile(os.path.join(out, ENTRY)):
        raise Refused(f"the bundle has no {ENTRY}; make build must write the Worker's entry there")


def strip_jsonc(text):
    """JSON with comments and trailing commas, as wrangler.jsonc allows, to plain JSON."""
    out, i, n = [], 0, len(text)
    while i < n:
        c = text[i]
        if c == '"':
            j = i + 1
            while j < n and text[j] != '"':
                j += 2 if text[j] == "\\" else 1
            out.append(text[i:j + 1])
            i = j + 1
        elif text.startswith("//", i):
            while i < n and text[i] != "\n":
                i += 1
        elif text.startswith("/*", i):
            end = text.find("*/", i + 2)
            if end < 0:
                raise Refused("unterminated /* comment in the config")
            i = end + 2
        else:
            out.append(c)
            i += 1
    return re.sub(r",(\s*[}\]])", r"\1", "".join(out))


def load_config(path):
    with open(path, encoding="utf-8") as f:
        text = f.read()
    try:
        if path.endswith(".toml"):
            return tomllib.loads(text)
        return json.loads(strip_jsonc(text))
    except (tomllib.TOMLDecodeError, json.JSONDecodeError) as e:
        raise Refused(f"can't parse {os.path.basename(path)}: {e}") from e


def sanitize(cfg, env):
    """The config the deploy job uses, and the notes to print."""
    if not isinstance(cfg.get("name"), str) or not cfg["name"]:
        raise Refused("the config has no name")
    envs = cfg.get("env") or {}
    if env not in envs:
        raise Refused(f"the config has no env.{env}. Add it; the Worker deploys as {cfg['name']}-{env}")
    notes = []
    sections = [("", cfg)] + [(f"env.{k}.", v) for k, v in envs.items() if isinstance(v, dict)]
    for prefix, section in sections:
        for key, why in REFUSE.items():
            if key in section:
                raise Refused(f"{prefix}{key} is set: {why}")
        for key, why in STRIP.items():
            if section.pop(key, None) is not None:
                notes.append(f"Removed {prefix}{key}: {why}")
        section.pop("main", None)
    cfg["main"] = ENTRY
    return cfg, notes


def build_id(out, sha):
    version = "0.0.0"
    pkg = os.path.join(out, "package.json")
    if os.path.isfile(pkg):
        try:
            with open(pkg, encoding="utf-8") as f:
                v = json.load(f).get("version")
            if isinstance(v, str) and VERSION.match(v):
                version = v
        except (json.JSONDecodeError, AttributeError):
            pass
    return f"{version}+{sha[:7]}"


def main(argv=None):
    p = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    p.add_argument("--bundle", required=True)
    p.add_argument("--digest", required=True)
    p.add_argument("--config", required=True, choices=CONFIG_NAMES)
    p.add_argument("--env", required=True, choices=("preview", "staging"))
    p.add_argument("--sha", required=True)
    p.add_argument("--out", required=True)
    a = p.parse_args(argv)
    try:
        if not re.fullmatch(r"[0-9a-f]{64}", a.digest):
            raise Refused("the build job's digest is missing or malformed")
        if not re.fullmatch(r"[0-9a-f]{40}", a.sha):
            raise Refused("the commit SHA is missing or malformed")
        actual = sha256(a.bundle)
        if actual != a.digest:
            raise Refused(f"bundle sha256 {actual} doesn't match the build job's {a.digest}")
        os.makedirs(a.out, exist_ok=True)
        unpack(a.bundle, a.config, a.out)
        original = os.path.join(a.out, a.config)
        cfg, notes = sanitize(load_config(original), a.env)
        # Only the sanitized copy stays, so wrangler can't find the original.
        os.remove(original)
        with open(os.path.join(a.out, "wrangler.json"), "w", encoding="utf-8") as f:
            json.dump(cfg, f, indent=2)
        bid = build_id(a.out, a.sha)
        with open(os.path.join(a.out, "build-id"), "w", encoding="utf-8") as f:
            f.write(bid)
    except Refused as e:
        print(f"FAIL  {e}", file=sys.stderr)
        return 1
    for n in notes:
        print(f"INFO  {n}")
    print(f"PASS  bundle {a.digest[:12]} unpacked; deploying {cfg['name']}-{a.env}, build {bid}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
