#!/usr/bin/env bash
# deploy.sh — Deploy the orchestrator to the factory account from a clean tree.
#
#   bash orchestrator/deploy.sh            deploy, then check /health
#   bash orchestrator/deploy.sh --health   only check /health against this checkout
#
# orchestrator-deploy.yml runs this on merge, with these values from the broker.
# By hand, it reads them from .env.local at the repo root and the environment:
#   CLOUDFLARE_DEPLOY_TOKEN or CLOUDFLARE_API_TOKEN
#   CLOUDFLARE_ACCOUNT_ID    the factory account
#   APPROVER_LOGIN           the only login that can release an issue
#   ALLOWED_REPOS            comma-separated owner/name list
#   ORCHESTRATOR_URL         optional; the Worker's URL, for /health
#   EGRESS_HOSTS             optional; JSON, each repo's package registries.
#                            {"owner/name": ["registry.npmjs.org"]}. Default: none
#   ACCESS_TEAM, ACCESS_AUD, OPERATOR_EMAIL
#                            optional; Cloudflare Access for the /api routes. Unset
#                            refuses every /api request
#
# The App id comes from AGENT_APP_ID, or from the Keychain item create-app.py stored.
# The approver, repos and App id are passed with --var rather than committed, because
# a consumer's repo name can be private.

set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(dirname "$HERE")"
APP_SLUG="${APP_SLUG:-danjamk-build-agent}"

if [ -f "$ROOT/.env.local" ]; then
    set -a
    # shellcheck disable=SC1091
    . "$ROOT/.env.local"
    set +a
fi

# The same variable names deploy/cloudflare/deploy.sh takes from the broker.
export CLOUDFLARE_API_TOKEN="${CLOUDFLARE_DEPLOY_TOKEN:-${CLOUDFLARE_API_TOKEN:-}}"
unset CLOUDFLARE_DEPLOY_TOKEN
export WRANGLER_SEND_METRICS=false

VERSION=$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["version"])' "$ROOT/package.json")
BUILD_ID="$VERSION+$(git -C "$ROOT" rev-parse --short HEAD)"

check_health() {
    if [ -z "${ORCHESTRATOR_URL:-}" ]; then
        echo "ORCHESTRATOR_URL isn't set in .env.local, so /health wasn't checked." >&2
        return 2
    fi
    local live=""
    # A new version can take a few seconds to reach every location. No -S: curl's
    # errors name the host, and the URL stays out of a public repo's logs.
    for _ in 1 2 3 4 5 6; do
        live=$(curl -s --max-time 5 "$ORCHESTRATOR_URL/health" || true)
        if [ "$live" = "$BUILD_ID" ]; then
            echo "/health reports $live, matching this checkout."
            return 0
        fi
        sleep 5
    done
    echo "FAILED  /health reports '$live'; this checkout is $BUILD_ID." >&2
    return 1
}

if [ "${1:-}" = "--health" ]; then
    check_health
    exit $?
fi

for name in CLOUDFLARE_API_TOKEN CLOUDFLARE_ACCOUNT_ID APPROVER_LOGIN ALLOWED_REPOS; do
    if [ -z "${!name:-}" ]; then
        echo "$name isn't set." >&2
        exit 1
    fi
done

if [ -n "$(git -C "$ROOT" status --porcelain)" ]; then
    echo "The tree has uncommitted changes, so the build id wouldn't describe what deploys." >&2
    exit 1
fi

APP_ID="${AGENT_APP_ID:-$(security find-generic-password -s secure-agent-workflow -a "$APP_SLUG:app-id" -w)}"

echo "Deploying $BUILD_ID."
cd "$HERE"
pnpm exec wrangler deploy \
    --var "BUILD_ID:$BUILD_ID" \
    --var "GITHUB_APP_ID:$APP_ID" \
    --var "APPROVER_LOGIN:$APPROVER_LOGIN" \
    --var "ALLOWED_REPOS:$ALLOWED_REPOS" \
    --var "EGRESS_HOSTS:${EGRESS_HOSTS:-"{}"}" \
    ${ACCESS_TEAM:+--var "ACCESS_TEAM:$ACCESS_TEAM"} \
    ${ACCESS_AUD:+--var "ACCESS_AUD:$ACCESS_AUD"} \
    ${OPERATOR_EMAIL:+--var "OPERATOR_EMAIL:$OPERATOR_EMAIL"}

check_health
