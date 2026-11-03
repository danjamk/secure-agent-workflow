#!/usr/bin/env bash
# connect-app.sh — Connect the agent GitHub App to the deployed Worker.
#
#   bash orchestrator/connect-app.sh
#
# Copies the App's private key and webhook secret from the Keychain items
# create-app.py stored to Worker secrets, then points the App's webhook at the
# Worker. Values travel through pipes: nothing is printed or written to disk. Safe
# to run again.
#
# Reads CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID and ORCHESTRATOR_URL from .env.local.

set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(dirname "$HERE")"
SLUG="${APP_SLUG:-danjamk-build-agent}"
SERVICE=secure-agent-workflow

set -a
# shellcheck disable=SC1091
. "$ROOT/.env.local"
set +a

for name in CLOUDFLARE_API_TOKEN CLOUDFLARE_ACCOUNT_ID ORCHESTRATOR_URL; do
    if [ -z "${!name:-}" ]; then
        echo "$name isn't set in .env.local." >&2
        exit 1
    fi
done

keychain() { security find-generic-password -s "$SERVICE" -a "$SLUG:$1" -w; }
b64url() { openssl base64 -A | tr '+/' '-_' | tr -d '='; }

cd "$HERE"

# GitHub issues PKCS#1 keys and WebCrypto imports only PKCS#8.
echo "Storing the private key as a Worker secret."
keychain private-key | openssl base64 -d -A | openssl pkcs8 -topk8 -nocrypt \
    | pnpm exec wrangler secret put GITHUB_APP_PRIVATE_KEY

echo "Storing the webhook secret as a Worker secret."
keychain webhook-secret | pnpm exec wrangler secret put GITHUB_WEBHOOK_SECRET

# App JWT: RS256, 10-minute ceiling. iat is backdated a minute for clock drift.
NOW=$(date +%s)
HEADER=$(printf '{"alg":"RS256","typ":"JWT"}' | b64url)
PAYLOAD=$(printf '{"iat":%d,"exp":%d,"iss":"%s"}' $((NOW - 60)) $((NOW + 540)) "$(keychain app-id)" | b64url)
SIGNATURE=$(printf '%s.%s' "$HEADER" "$PAYLOAD" \
    | openssl dgst -sha256 -sign <(keychain private-key | openssl base64 -d -A) \
    | b64url)

echo "Pointing the App's webhook at the Worker."
BODY=$(python3 -c 'import json,sys; print(json.dumps({"url": sys.argv[1] + "/webhook", "content_type": "json"}))' "$ORCHESTRATOR_URL")
curl -sS --fail-with-body -o /dev/null -X PATCH \
    -H "Authorization: Bearer $HEADER.$PAYLOAD.$SIGNATURE" \
    -H "Accept: application/vnd.github+json" \
    -H "X-GitHub-Api-Version: 2022-11-28" \
    -d "$BODY" \
    https://api.github.com/app/hook/config

echo
echo "Done. GitHub's API doesn't set whether a webhook is active. If it isn't yet, tick"
echo "Active under Webhook at https://github.com/settings/apps/$SLUG"
