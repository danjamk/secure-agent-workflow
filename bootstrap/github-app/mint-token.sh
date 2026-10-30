#!/usr/bin/env bash
# mint-token.sh — Mint a 1-hour installation token for one repo, for local verification.
#
#   bash bootstrap/github-app/mint-token.sh danjamk-build-agent danjamk/agent-testbed
#
# Reads the App id and private key that create-app.py stored in the macOS Keychain
# and prints the token on stdout. The token is scoped to the one repo named.
#
# Not the production path: the orchestrator mints its own tokens from a Worker
# secret, and the private key never enters the sandbox (ADR-001).

set -euo pipefail

SLUG="${1:-}"
REPO="${2:-}"
if [ -z "$SLUG" ] || [ -z "$REPO" ]; then
    echo "Usage: mint-token.sh <app-slug> <owner>/<repo>" >&2
    exit 1
fi

SERVICE=secure-agent-workflow
keychain() { security find-generic-password -s "$SERVICE" -a "$SLUG:$1" -w; }
b64url() { openssl base64 -A | tr '+/' '-_' | tr -d '='; }

APP_ID=$(keychain app-id)

# App JWT: RS256, 10-minute ceiling. iat is backdated a minute for clock drift,
# as GitHub's docs recommend.
NOW=$(date +%s)
HEADER=$(printf '{"alg":"RS256","typ":"JWT"}' | b64url)
PAYLOAD=$(printf '{"iat":%d,"exp":%d,"iss":"%s"}' $((NOW - 60)) $((NOW + 540)) "$APP_ID" | b64url)
# The key goes to openssl through a pipe, never a file.
SIGNATURE=$(printf '%s.%s' "$HEADER" "$PAYLOAD" \
    | openssl dgst -sha256 -sign <(keychain private-key | openssl base64 -d -A) \
    | b64url)
JWT="$HEADER.$PAYLOAD.$SIGNATURE"

api() {
    curl -sS --fail-with-body \
        -H "Authorization: Bearer $JWT" \
        -H "Accept: application/vnd.github+json" \
        -H "X-GitHub-Api-Version: 2022-11-28" \
        "$@"
}

INSTALLATION_ID=$(api "https://api.github.com/repos/$REPO/installation" \
    | python3 -c 'import json,sys; print(json.load(sys.stdin)["id"])')

api -X POST "https://api.github.com/app/installations/$INSTALLATION_ID/access_tokens" \
    -d "{\"repositories\":[\"${REPO#*/}\"]}" \
    | python3 -c 'import json,sys; print(json.load(sys.stdin)["token"])'
