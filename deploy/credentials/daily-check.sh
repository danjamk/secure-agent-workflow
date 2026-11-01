#!/usr/bin/env bash
# The daily credential check's one step (#55, ADR-007). Run by the consumer's
# .github/workflows/credential-check.yml, which bootstrap installs, from a
# checkout of this repo at the pinned commit. Not for local use: locally,
# `broker.sh status` covers the same checks and more.
#
# Takes the staging role through GitHub OIDC, then runs
# `credentials.py check <repo> --issue` with the role's credentials. They exist
# only in this process.
#
# Environment, set by the workflow:
#   ROLE        staging's AWS_ROLE_ARN secret
#   AWS_REGION  staging's AWS_REGION variable
#   REPO        owner/repo
#   GH_TOKEN    the job's token, with issues: write
#   ACTIONS_ID_TOKEN_REQUEST_URL, ACTIONS_ID_TOKEN_REQUEST_TOKEN  from id-token: write
set -euo pipefail

HERE=$(cd "$(dirname "$0")" && pwd)

if [ -z "${ROLE:-}" ]; then
    echo "FAIL  staging has no AWS_ROLE_ARN secret. Run: broker.sh add-repo $REPO"
    exit 1
fi
if [ -z "${ACTIONS_ID_TOKEN_REQUEST_URL:-}" ]; then
    echo "FAIL  no OIDC token available; the job needs permissions: id-token: write"
    exit 1
fi
# The ARN isn't secret, but it holds the AWS account ID, and a public repo's
# logs are public.
echo "::add-mask::$ROLE"

oidc=$(curl -sSf -H "Authorization: bearer $ACTIONS_ID_TOKEN_REQUEST_TOKEN" \
    "$ACTIONS_ID_TOKEN_REQUEST_URL&audience=sts.amazonaws.com" | jq -r .value)
echo "::add-mask::$oidc"

creds=$(aws sts assume-role-with-web-identity --role-arn "$ROLE" \
    --role-session-name "credential-check-$GITHUB_RUN_ID" --web-identity-token "$oidc" \
    --query 'Credentials.[AccessKeyId,SecretAccessKey,SessionToken]' --output text)
read -r AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY AWS_SESSION_TOKEN <<<"$creds"
echo "::add-mask::$AWS_SECRET_ACCESS_KEY"
echo "::add-mask::$AWS_SESSION_TOKEN"
export AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY AWS_SESSION_TOKEN

exec python3 "$HERE/credentials.py" check "$REPO" --issue
