#!/usr/bin/env bash
# deploy.sh — Deploy the console to the factory account from a clean tree.
#
# console-deploy.yml runs this on merge, with these values from the broker. By
# hand, it reads them from .env.local at the repo root and the environment:
#   CLOUDFLARE_DEPLOY_TOKEN or CLOUDFLARE_API_TOKEN
#   CLOUDFLARE_ACCOUNT_ID    the factory account
#
# There's no /health check after the deploy: Cloudflare Access covers the whole
# Worker, so an unauthenticated check gets Access's sign-in page. wrangler's own
# result says whether the deploy worked.

set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(dirname "$HERE")"

if [ -f "$ROOT/.env.local" ]; then
    set -a
    # shellcheck disable=SC1091
    . "$ROOT/.env.local"
    set +a
fi

export CLOUDFLARE_API_TOKEN="${CLOUDFLARE_DEPLOY_TOKEN:-${CLOUDFLARE_API_TOKEN:-}}"
unset CLOUDFLARE_DEPLOY_TOKEN
export WRANGLER_SEND_METRICS=false

for name in CLOUDFLARE_API_TOKEN CLOUDFLARE_ACCOUNT_ID; do
    if [ -z "${!name:-}" ]; then
        echo "$name isn't set." >&2
        exit 1
    fi
done

if [ -n "$(git -C "$ROOT" status --porcelain)" ]; then
    echo "The tree has uncommitted changes, so the build id wouldn't describe what deploys." >&2
    exit 1
fi

VERSION=$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["version"])' "$ROOT/package.json")
BUILD_ID="$VERSION+$(git -C "$ROOT" rev-parse --short HEAD)"

echo "Deploying the console $BUILD_ID."
cd "$HERE"
pnpm exec wrangler deploy --var "BUILD_ID:$BUILD_ID"
