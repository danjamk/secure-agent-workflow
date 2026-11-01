#!/usr/bin/env bash
# Posts the preview URL on the PR, editing the deploy job's earlier comment
# instead of adding one per push (#18).
#
# Environment: GH_TOKEN (pull-requests: write), REPO, PR_NUMBER, URL, SHA.
set -euo pipefail

marker="<!-- saw-preview -->"
body="$marker
**Preview:** $URL

Built from ${SHA:0:7}. Updated on every push to this PR."

id=$(gh api "repos/$REPO/issues/$PR_NUMBER/comments" --paginate \
    --jq ".[] | select(.user.login == \"github-actions[bot]\" and (.body | startswith(\"$marker\"))) | .id" \
    | head -1)
if [ -n "$id" ]; then
    gh api -X PATCH "repos/$REPO/issues/comments/$id" -f body="$body" --silent
else
    gh api -X POST "repos/$REPO/issues/$PR_NUMBER/comments" -f body="$body" --silent
fi
echo "Posted the preview URL on PR #$PR_NUMBER"
