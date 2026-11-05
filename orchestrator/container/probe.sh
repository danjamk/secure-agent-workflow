#!/bin/bash
# probe.sh — Tests the outbound policy from inside a run's container (#79).
#
# A release runs this instead of an agent, and the orchestrator posts its output on
# the issue. Every check that should fail is aimed at the testbed or at a fake id,
# so a broken filter shows up as a FAIL line instead of a change.
#
# Leaves behind, on the testbed: the branch agent/<issue>-<slug>, a draft PR from
# it, and one comment on the issue. Clean these up by hand.
#
# Takes REPO, ISSUE, SLUG and DEFAULT_BRANCH from the environment. Nothing else is
# set, and the container holds no credentials: the Worker adds them outside.

set -u

PASSED=0
FAILED=0
API="https://api.github.com"
BLOCKED="Blocked by the outbound policy"
BRANCH="agent/$ISSUE-$SLUG"
# What a leaked credential would look like.
SECRET='ghs_[A-Za-z0-9]{20}|ghp_[A-Za-z0-9]{20}|github_pat_|sk-ant-[A-Za-z0-9]|sk-proj-|x-access-token:|BEGIN (RSA |EC |OPENSSH )?PRIVATE KEY'

section() { printf '\n## %s\n' "$1"; }

result() {
    local outcome=$1 name=$2 detail=${3:-}
    detail=$(printf '%s' "$detail" | tr '\n\r' '  ' | cut -c1-160)
    if [ "$outcome" = pass ]; then
        PASSED=$((PASSED + 1))
        echo "PASS  $name${detail:+ ($detail)}"
    else
        FAILED=$((FAILED + 1))
        echo "FAIL  $name${detail:+ ($detail)}"
    fi
}

must_succeed() {
    local name=$1 out
    shift
    if out=$(timeout 60 "$@" 2>&1); then
        result pass "$name"
    else
        result fail "$name" "$(printf '%s' "$out" | tail -n 2)"
    fi
}

must_fail() {
    local name=$1 out
    shift
    if out=$(timeout 30 "$@" 2>&1); then
        result fail "$name" "it worked: $(printf '%s' "$out" | head -c 120)"
    else
        result pass "$name" "$(printf '%s' "$out" | tail -n 1)"
    fi
}

# call METHOD URL [JSON]: sets STATUS and writes the body to /tmp/body.
call() {
    local args=(-s -o /tmp/body -w '%{http_code}' --max-time 30 -X "$1" -H 'Accept: application/vnd.github+json')
    [ $# -ge 3 ] && args+=(-H 'Content-Type: application/json' --data "$3")
    STATUS=$(curl "${args[@]}" "$2") || STATUS="000"
}

expect_status() {
    local name=$1 want=$2
    shift 2
    call "$@"
    if [ "$STATUS" = "$want" ]; then
        result pass "$name"
    else
        result fail "$name" "got $STATUS: $(head -c 120 /tmp/body 2>/dev/null)"
    fi
}

# Denied by the Worker's policy, not by GitHub: the body says so.
expect_denied() {
    local name=$1 want=$2
    shift 2
    call "$@"
    if [ "$STATUS" = "$want" ] && grep -q "$BLOCKED" /tmp/body; then
        result pass "$name" "$(head -c 120 /tmp/body)"
    else
        result fail "$name" "got $STATUS: $(head -c 120 /tmp/body 2>/dev/null)"
    fi
}

graphql_body() { jq -cn --arg q "$1" '{query: $q}'; }

echo "Outbound probe for $REPO#$ISSUE, branch $BRANCH"

section "Network"
must_fail "blocked host over HTTPS" curl -fsS --max-time 20 https://example.com/
must_fail "blocked host over HTTP" curl -fsS --max-time 20 http://example.com/
must_fail "bare IP over HTTPS" curl -fsS --max-time 20 https://1.1.1.1/
must_fail "bare IP over HTTP" curl -fsS --max-time 20 http://1.1.1.1/
must_fail "cloud metadata address" curl -fsS --max-time 20 http://169.254.169.254/
must_fail "raw TCP to port 22" bash -c 'exec 3<>/dev/tcp/1.1.1.1/22'
must_fail "DNS for an unlisted name" getent hosts unlisted-name.example.com
must_fail "plain HTTP to github.com" curl -fsS --max-time 20 http://github.com/
must_fail "another GitHub host" curl -fsS --max-time 20 https://raw.githubusercontent.com/
echo "info  github.com resolves to: $(getent hosts github.com | head -n 1)"

section "Git"
must_succeed "clone the run's repo" git clone -q "https://github.com/$REPO.git" /tmp/repo
if [ -d /tmp/repo/.git ]; then
cd /tmp/repo
git config user.name "outbound probe"
git config user.email "probe@invalid"
git checkout -q -b "$BRANCH"
echo "Written by the outbound probe ($SLUG). Safe to delete." > "probe-$SLUG.md"
git add "probe-$SLUG.md"
git commit -q -m "test: outbound probe $SLUG"
must_succeed "push the run's branch" git push -q origin "$BRANCH"
echo "Second commit." >> "probe-$SLUG.md"
git commit -q -am "test: outbound probe $SLUG, second commit"
must_succeed "push a second commit" git push -q origin "$BRANCH"
must_fail "clone another repo" git clone -q https://github.com/cli/cli.git /tmp/other
must_fail "push to the default branch" git push -q origin "HEAD:refs/heads/$DEFAULT_BRANCH"
must_fail "push a second branch" git push -q origin "HEAD:refs/heads/agent/$ISSUE-$SLUG-two"
must_fail "push another issue's branch" git push -q origin "HEAD:refs/heads/agent/999999-$SLUG"
must_fail "push a tag" git push -q origin "HEAD:refs/tags/probe-$SLUG"
must_fail "delete the run's branch" git push -q origin --delete "$BRANCH"
git commit -q --amend -m "test: outbound probe $SLUG, rewritten"
must_fail "force-push the run's branch" git push -q --force origin "$BRANCH"
must_fail "a token in .git/config" grep -Eq "$SECRET" .git/config
cd /
else
    result fail "push checks" "skipped, because the clone failed"
fi

section "GitHub API"
expect_status "read the run's issue" 200 GET "$API/repos/$REPO/issues/$ISSUE"
pull=$(jq -cn --arg head "$BRANCH" --arg base "$DEFAULT_BRANCH" --arg slug "$SLUG" \
    '{title: ("Outbound probe " + $slug), head: $head, base: $base, draft: true,
      body: "Opened by the outbound probe (#79). Not for merging."}')
expect_status "open the run's draft PR" 201 POST "$API/repos/$REPO/pulls" "$pull"
PR_NUMBER=$(jq -r '.number // empty' /tmp/body 2>/dev/null)
PR_NODE=$(jq -r '.node_id // empty' /tmp/body 2>/dev/null)
expect_status "comment on the run's issue" 201 POST "$API/repos/$REPO/issues/$ISSUE/comments" \
    '{"body":"Comment from the outbound probe (#79)."}'
if [ -n "$PR_NODE" ]; then
    call POST "$API/graphql" "$(graphql_body "mutation { markPullRequestReadyForReview(input: {pullRequestId: \"$PR_NODE\"}) { clientMutationId } }")"
    if [ "$STATUS" = 200 ] && ! grep -q '"errors"' /tmp/body; then
        result pass "mark the run's PR ready"
    else
        result fail "mark the run's PR ready" "got $STATUS: $(head -c 120 /tmp/body)"
    fi
else
    result fail "mark the run's PR ready" "no PR to mark"
fi
expect_status "read with a GraphQL query" 200 POST "$API/graphql" "$(graphql_body '{ viewer { login } }')"
expect_denied "comment on another issue" 403 POST "$API/repos/$REPO/issues/999999/comments" '{"body":"x"}'
expect_denied "submit a review" 403 POST "$API/repos/$REPO/pulls/${PR_NUMBER:-1}/reviews" '{"event":"APPROVE"}'
expect_denied "merge the PR" 403 PUT "$API/repos/$REPO/pulls/${PR_NUMBER:-1}/merge" '{}'
expect_denied "close a blocker from the PR body" 403 PATCH "$API/repos/$REPO/pulls/${PR_NUMBER:-1}" '{"body":"Closes #999999"}'
expect_denied "remove agent:stop" 403 DELETE "$API/repos/$REPO/issues/$ISSUE/labels/agent:stop"
expect_denied "add agent:ready" 403 POST "$API/repos/$REPO/issues/$ISSUE/labels" '{"labels":["agent:ready"]}'
expect_denied "close the issue" 403 PATCH "$API/repos/$REPO/issues/$ISSUE" '{"state":"closed"}'
expect_denied "move a ref through the API" 403 PATCH "$API/repos/$REPO/git/refs/heads/$DEFAULT_BRANCH" '{"sha":"0000000000000000000000000000000000000000","force":true}'
expect_denied "read the App's installation" 403 GET "$API/installation/repositories"
expect_denied "read another repo" 403 GET "$API/repos/cli/cli"
expect_denied "merge by GraphQL" 403 POST "$API/graphql" \
    "$(graphql_body 'mutation { mergePullRequest(input: {pullRequestId: "PR_fake"}) { clientMutationId } }')"
expect_denied "remove a label by GraphQL" 403 POST "$API/graphql" \
    "$(graphql_body 'mutation { removeLabelsFromLabelable(input: {labelableId: "I_fake", labelIds: ["LA_fake"]}) { clientMutationId } }')"
expect_denied "a batch of GraphQL operations" 403 POST "$API/graphql" '[{"query":"{ viewer { login } }"}]'
expect_denied "a model call with no key set" 503 POST "https://api.anthropic.com/v1/messages" \
    '{"model":"any","max_tokens":1,"messages":[]}'

section "Credentials"
must_fail "a credential in the environment" bash -c "env | grep -Eq '$SECRET'"
must_fail "a credential in a process environment" bash -c "cat /proc/[0-9]*/environ 2>/dev/null | tr '\0' '\n' | grep -Eq '$SECRET'"
must_fail "a credential in a file" grep -rIlEq --exclude=probe.out "$SECRET" /etc /root /home /tmp /var /opt /usr/local

printf '\nResults: %d passed, %d failed\n' "$PASSED" "$FAILED"
[ "$FAILED" -eq 0 ]
