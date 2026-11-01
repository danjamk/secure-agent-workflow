#!/usr/bin/env bash
# Deploys a prepared bundle to the dev target (#18). Run by the consumer's
# deploy workflow from a checkout of this repo at the pinned commit, after
# prepare.py and the broker action. Runs no code from the consumer repo: the
# wrangler here comes from this folder's lockfile, and the bundle is uploaded
# as built (--no-bundle).
#
#   deploy.sh preview <dir>   upload a version of <worker>-preview with alias
#                             pr-<PR_NUMBER>; its URL goes to GITHUB_OUTPUT
#   deploy.sh staging <dir>   deploy <worker>-staging, then check /health
#                             returns this build's id
#
# Environment: CLOUDFLARE_DEPLOY_TOKEN and CLOUDFLARE_ACCOUNT_ID from the
# broker action; PR_NUMBER for preview.
set -euo pipefail

mode=${1:?usage: deploy.sh preview|staging <dir>}
dir=${2:?usage: deploy.sh preview|staging <dir>}
HERE=$(cd "$(dirname "$0")" && pwd)
WRANGLER="$HERE/node_modules/.bin/wrangler"

[ -x "$WRANGLER" ] || { echo "FAIL  wrangler isn't installed: npm ci --ignore-scripts --prefix $HERE" >&2; exit 1; }
: "${CLOUDFLARE_DEPLOY_TOKEN:?FAIL  no CLOUDFLARE_DEPLOY_TOKEN; run the broker action first}"
: "${CLOUDFLARE_ACCOUNT_ID:?FAIL  no CLOUDFLARE_ACCOUNT_ID; run the broker action first}"
export CLOUDFLARE_API_TOKEN=$CLOUDFLARE_DEPLOY_TOKEN CLOUDFLARE_ACCOUNT_ID
unset CLOUDFLARE_DEPLOY_TOKEN
export WRANGLER_SEND_METRICS=false CI=true

build_id=$(cat "$dir/build-id")
cd "$dir"
common=(dist/index.js --no-bundle --config wrangler.json --env "$mode"
        --var "BUILD_ID:$build_id" --message "$build_id from ${GITHUB_REPOSITORY:-local}")

output() { [ -n "${GITHUB_OUTPUT:-}" ] && echo "$1" >>"$GITHUB_OUTPUT"; return 0; }

case $mode in
preview)
    : "${PR_NUMBER:?FAIL  PR_NUMBER is required for a preview}"
    upload() { "$WRANGLER" versions upload "${common[@]}" --preview-alias "pr-$PR_NUMBER" 2>&1; }
    if ! out=$(upload); then
        echo "$out"
        # A version upload needs the Worker to exist. The first preview
        # deploys it once; previews after that only add versions.
        # wrangler 4.151.1: "You cannot upload a new version of a Worker that
        # does not yet exist. Please run the `deploy` command first."
        if grep -qiE "does not (yet )?exist|not found|10007" <<<"$out"; then
            echo "The preview Worker doesn't exist yet; deploying it once."
            "$WRANGLER" deploy "${common[@]}" --autoconfig=false
            out=$(upload) || { echo "$out"; exit 1; }
        else
            exit 1
        fi
    fi
    echo "$out"
    url=$(grep -oE "https://pr-$PR_NUMBER-[a-z0-9.-]+\.workers\.dev" <<<"$out" | head -1 || true)
    [ -n "$url" ] || url=$(grep -oE 'https://[a-z0-9.-]+\.workers\.dev' <<<"$out" | head -1 || true)
    [ -n "$url" ] || { echo "FAIL  no preview URL in wrangler's output; is the account's workers.dev subdomain set up?" >&2; exit 1; }
    output "url=$url"
    echo "PASS  preview $build_id at $url"
    ;;
staging)
    out=$("$WRANGLER" deploy "${common[@]}" --autoconfig=false 2>&1) || { echo "$out"; exit 1; }
    echo "$out"
    url=$(grep -oE 'https://[a-z0-9.-]+\.workers\.dev' <<<"$out" | head -1 || true)
    [ -n "$url" ] || { echo "FAIL  no workers.dev URL in wrangler's output; is the account's workers.dev subdomain set up?" >&2; exit 1; }
    output "url=$url"
    # A new deploy can take a few seconds to reach every location.
    for _ in $(seq 1 20); do
        got=$(curl -sf "$url/health" | jq -r '.build // empty' 2>/dev/null || true)
        if [ "$got" = "$build_id" ]; then
            echo "PASS  staging serves $build_id at $url"
            exit 0
        fi
        sleep 3
    done
    echo "FAIL  $url/health returned build '${got:-nothing}', expected $build_id" >&2
    exit 1
    ;;
*)
    echo "usage: deploy.sh preview|staging <dir>" >&2
    exit 1
    ;;
esac
