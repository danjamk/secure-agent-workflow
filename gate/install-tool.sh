#!/usr/bin/env bash
# install-tool.sh — Download a tool pinned in tools.txt, verify its SHA-256,
# and install the binary into a directory.
#
#   bash gate/install-tool.sh gitleaks "$RUNNER_TEMP/bin"
#
# A checksum mismatch fails before anything is extracted or run.

set -euo pipefail

NAME="${1:-}"
DEST="${2:-}"
if [ -z "$NAME" ] || [ -z "$DEST" ]; then
    echo "Usage: install-tool.sh <name> <dest-dir>" >&2
    exit 1
fi

LINE=$(grep -E "^$NAME[[:space:]]" "$(dirname "$0")/tools.txt" || true)
if [ -z "$LINE" ]; then
    echo "install-tool.sh: $NAME is not in tools.txt" >&2
    exit 1
fi
read -r _ URL SHA MEMBER <<< "$LINE"

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

curl -sSfL --retry 3 -o "$TMP/download" "$URL"
# sha256sum on Linux runners; shasum on macOS, for running this locally.
if command -v sha256sum >/dev/null 2>&1; then
    echo "$SHA  $TMP/download" | sha256sum --check --quiet -
else
    echo "$SHA  $TMP/download" | shasum -a 256 --check --quiet -
fi

mkdir -p "$DEST"
if [ "$MEMBER" = "-" ]; then
    install -m 755 "$TMP/download" "$DEST/$NAME"
else
    tar -xzf "$TMP/download" -C "$TMP" "$MEMBER"
    install -m 755 "$TMP/$MEMBER" "$DEST/$NAME"
fi
echo "Installed $NAME from $URL (sha256 verified)"
