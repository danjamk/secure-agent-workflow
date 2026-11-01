#!/usr/bin/env bash
# The daily credential check's one step (#55, ADR-007). Run by the consumer's
# .github/workflows/credential-check.yml, which bootstrap installs, from a
# checkout of this repo at the pinned commit. Not for local use: locally,
# `broker.sh status` covers the same checks and more.
#
# Takes the staging role through GitHub OIDC (the broker's assume-role.sh),
# then runs `credentials.py check <repo> --issue` with the role's credentials.
# They exist only in this process.
#
# Environment, set by the workflow:
#   ROLE        staging's AWS_ROLE_ARN secret
#   AWS_REGION  staging's AWS_REGION variable
#   REPO        owner/repo
#   GH_TOKEN    the job's token, with issues: write
#   ACTIONS_ID_TOKEN_REQUEST_URL, ACTIONS_ID_TOKEN_REQUEST_TOKEN  from id-token: write
set -euo pipefail

HERE=$(cd "$(dirname "$0")" && pwd)
# shellcheck source=../broker/aws/assume-role.sh
. "$HERE/../broker/aws/assume-role.sh"

saw_assume_role "${ROLE:-}" "credential-check-$GITHUB_RUN_ID"

exec python3 "$HERE/credentials.py" check "$REPO" --issue
