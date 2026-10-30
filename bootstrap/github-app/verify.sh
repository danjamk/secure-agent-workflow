#!/usr/bin/env bash
# verify.sh — Check that the build-agent App can do its job and nothing more.
#
#   bash bootstrap/github-app/verify.sh danjamk/agent-testbed
#   bash bootstrap/github-app/verify.sh danjamk/agent-testbed \
#       --build danjamk-build-agent --reviewer danjamk-testbed-reviewer
#
# Needs a testbed repo with at least one commit and both Apps installed on it.
# Dan's own gh identity is used only for setup and cleanup: a temporary ruleset
# (testbed-ruleset.json) that requires one approval and a check that never
# reports, so the test PR stays open and auto-merge has something to wait for.
# Everything under test runs with App installation tokens.
#
# Exit code 0 if every expectation held. Rows marked "record" have no expected
# outcome; they answer open questions from the research.

set -euo pipefail

REPO=""
BUILD=danjamk-build-agent
REVIEWER=danjamk-testbed-reviewer

while [ $# -gt 0 ]; do
    case "$1" in
        --build)    BUILD="${2:-}"; shift 2 ;;
        --reviewer) REVIEWER="${2:-}"; shift 2 ;;
        -*)         echo "Unknown flag: $1"; exit 1 ;;
        *)          REPO="$1"; shift ;;
    esac
done

if [ -z "$REPO" ]; then
    echo "Usage: verify.sh <owner>/<repo> [--build SLUG] [--reviewer SLUG]"
    exit 1
fi

HERE="$(cd "$(dirname "$0")" && pwd)"
GH=gh
command -v ghw >/dev/null 2>&1 && GH=ghw

WORK="$(mktemp -d)"
BRANCH="agent/verify-$(date +%s)"
RULESET_ID=""
PR_NUMBER=""
FAILED=0

cleanup() {
    cd /
    if [ -n "$PR_NUMBER" ]; then
        $GH api -X PATCH "repos/$REPO/pulls/$PR_NUMBER" -f state=closed --silent || true
    fi
    $GH api -X DELETE "repos/$REPO/git/refs/heads/$BRANCH" --silent 2>/dev/null || true
    if [ -n "$RULESET_ID" ]; then
        $GH api -X DELETE "repos/$REPO/rulesets/$RULESET_ID" --silent || true
    fi
    rm -rf "$WORK"
}
trap cleanup EXIT

# --- Helpers ---

# call TOKEN METHOD PATH [JSON] — prints the HTTP status; the body lands in $WORK/body.
call() {
    local token=$1 method=$2 path=$3 data=${4:-}
    local args=(-sS -o "$WORK/body" -w '%{http_code}' -X "$method"
        -H "Authorization: Bearer $token"
        -H "Accept: application/vnd.github+json"
        -H "X-GitHub-Api-Version: 2022-11-28")
    if [ -n "$data" ]; then
        args+=(-d "$data")
    fi
    curl "${args[@]}" "https://api.github.com$path"
}

field() { python3 -c "import json,sys; print(json.load(open('$WORK/body'))$1)"; }
outcome() { case "$1" in 2*) echo allowed ;; *) echo "blocked" ;; esac; }

# git as an App: the token goes in a header, and credential helpers are off so
# Dan's stored credentials can't stand in for it.
git_as() {
    local token=$1; shift
    local basic
    basic=$(printf 'x-access-token:%s' "$token" | openssl base64 -A)
    git -c credential.helper= \
        -c "http.https://github.com/.extraHeader=Authorization: Basic $basic" "$@"
}

commit() {
    git -c user.name=verify.sh -c user.email=verify@invalid commit -q -m "$1"
}

result() {
    local name=$1 expected=$2 got=$3 mark=PASS
    if [ "$expected" = record ]; then
        mark=INFO
    elif [ "$expected" != "$got" ]; then
        mark=FAIL
        FAILED=1
    fi
    printf '  %-4s  %-42s expected: %-8s got: %s\n' "$mark" "$name" "$expected" "$got"
}

# --- Setup, as Dan ---

echo ""
echo "Repo:     $REPO"
echo "Build:    $BUILD"
echo "Reviewer: $REVIEWER"
echo ""

DEFAULT=$($GH api "repos/$REPO" --jq .default_branch)
$GH api -X PATCH "repos/$REPO" -F allow_auto_merge=true --silent

EXISTING=$($GH api "repos/$REPO/rulesets" --jq \
    '.[] | select(.name == "verify-github-app") | .id' | head -1)
if [ -n "$EXISTING" ]; then
    $GH api -X DELETE "repos/$REPO/rulesets/$EXISTING" --silent
fi
RULESET_ID=$($GH api -X POST "repos/$REPO/rulesets" \
    --input "$HERE/testbed-ruleset.json" --jq .id)

BUILD_TOKEN=$(bash "$HERE/mint-token.sh" "$BUILD" "$REPO")
REVIEWER_TOKEN=$(bash "$HERE/mint-token.sh" "$REVIEWER" "$REPO")

# --- What the agent must be able to do ---

echo "Allowed:"

git_as "$BUILD_TOKEN" clone -q --depth 1 "https://github.com/$REPO.git" "$WORK/repo"
cd "$WORK/repo"
git checkout -q -b "$BRANCH"
date -u > verify.txt
git add verify.txt
commit "verify.sh: agent branch commit"
SHA=$(git rev-parse HEAD)

if git_as "$BUILD_TOKEN" push -q origin "$BRANCH" 2>"$WORK/push.err"; then
    result "push an agent/* branch" allowed allowed
else
    result "push an agent/* branch" allowed "blocked: $(tail -1 "$WORK/push.err")"
    exit 1
fi

STATUS=$(call "$BUILD_TOKEN" POST "/repos/$REPO/pulls" \
    "{\"title\":\"verify.sh\",\"head\":\"$BRANCH\",\"base\":\"$DEFAULT\",\"body\":\"Opened by verify.sh; closed automatically.\"}")
result "open a PR" allowed "$(outcome "$STATUS")"
if [ "$(outcome "$STATUS")" != allowed ]; then
    exit 1
fi
PR_NUMBER=$(field '["number"]')
PR_NODE=$(field '["node_id"]')

STATUS=$(call "$BUILD_TOKEN" POST "/repos/$REPO/issues/$PR_NUMBER/comments" \
    '{"body":"Comment from verify.sh."}')
result "comment on an issue or PR" allowed "$(outcome "$STATUS")"

# --- Open questions from docs/research/planning-agent-identity.md ---

echo ""
echo "Recorded:"

# Auto-merge exists only in GraphQL, which answers 200 with an errors array.
call "$BUILD_TOKEN" POST /graphql \
    "{\"query\":\"mutation(\$id:ID!){enablePullRequestAutoMerge(input:{pullRequestId:\$id,mergeMethod:SQUASH}){clientMutationId}}\",\"variables\":{\"id\":\"$PR_NODE\"}}" \
    >/dev/null
AUTOMERGE=$(python3 -c "
import json
body = json.load(open('$WORK/body'))
errors = body.get('errors')
print('blocked: ' + errors[0]['message'] if errors else 'allowed')")
result "enable auto-merge (GraphQL)" record "$AUTOMERGE"

STATUS=$(call "$REVIEWER_TOKEN" POST "/repos/$REPO/pulls/$PR_NUMBER/reviews" \
    '{"event":"APPROVE","body":"Approval from verify.sh reviewer App."}')
result "second App approves the PR" record "$(outcome "$STATUS")"

DECISION=$($GH api graphql \
    -f query='query($o:String!,$r:String!,$n:Int!){repository(owner:$o,name:$r){pullRequest(number:$n){reviewDecision}}}' \
    -f o="${REPO%/*}" -f r="${REPO#*/}" -F n="$PR_NUMBER" \
    --jq .data.repository.pullRequest.reviewDecision)
result "ruleset counts the App approval" record "$DECISION"

STATUS=$(call "$BUILD_TOKEN" GET "/repos/$REPO/rulesets")
result "read rulesets" record "$(outcome "$STATUS")"

# --- What the agent must not be able to do ---

echo ""
echo "Blocked:"

mkdir -p .github/workflows
printf 'name: verify\non: workflow_dispatch\njobs:\n  noop:\n    runs-on: ubuntu-latest\n    steps:\n      - run: "true"\n' \
    > .github/workflows/verify.yml
git add .github/workflows/verify.yml
commit "verify.sh: workflow file"
if git_as "$BUILD_TOKEN" push -q origin "$BRANCH" 2>"$WORK/push.err"; then
    result "push a .github/workflows/ file" blocked allowed
else
    result "push a .github/workflows/ file" blocked blocked
fi

STATUS=$(call "$BUILD_TOKEN" POST "/repos/$REPO/rulesets" \
    '{"name":"verify-agent-edit","target":"branch","enforcement":"disabled","rules":[{"type":"deletion"}]}')
result "create or edit a ruleset" blocked "$(outcome "$STATUS")"

STATUS=$(call "$BUILD_TOKEN" POST "/repos/$REPO/check-runs" \
    "{\"name\":\"verify-never-reports\",\"head_sha\":\"$SHA\",\"status\":\"completed\",\"conclusion\":\"success\"}")
result "create a check run" blocked "$(outcome "$STATUS")"

STATUS=$(call "$BUILD_TOKEN" POST "/repos/$REPO/statuses/$SHA" \
    '{"state":"success","context":"verify-never-reports"}')
result "create a commit status" blocked "$(outcome "$STATUS")"

echo ""
if [ "$FAILED" -eq 0 ]; then
    echo "All expectations held."
else
    echo "One or more expectations failed."
fi
exit "$FAILED"
