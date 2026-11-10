#!/bin/bash
# run-agent.sh — Runs the build agent on one issue (#9).
#
# The Worker writes the issue and the agent instructions to /workspace/task first,
# and passes the rest in the environment: REPO, ISSUE, DEFAULT_BRANCH, BOT_NAME,
# BOT_EMAIL, MODEL, MAX_TURNS, MAX_BUDGET_USD. A resumed run (#11) also gets
# RESUMED, RESUME_BRANCH and RESUME_PR, and the approver's reply in reply.md. A catch-up
# run (#111) gets CATCHUP too, and no reply. The container
# holds no credentials:
# ANTHROPIC_API_KEY is a placeholder, and the Worker adds the real key and the
# GitHub token outside.
#
# Writes Claude Code's events to /workspace/task/events.jsonl and its final result
# event to /workspace/task/result.json, which is what the Worker reports.

set -u
TASK=/workspace/task
REPO_DIR=/workspace/repo

echo "Agent run for $REPO#$ISSUE"

git config --global user.name "$BOT_NAME"
git config --global user.email "$BOT_EMAIL"

if ! git clone -q "https://github.com/$REPO.git" "$REPO_DIR"; then
    echo "The clone failed."
    exit 2
fi
cd "$REPO_DIR" || exit 2

RESUME_NOTE=""
if [ -n "${RESUMED:-}" ] && [ -z "${RESUME_BRANCH:-}" ]; then
    # Blocked before pushing anything, so there's no branch to continue from.
    RESUME_NOTE=" This run resumes an earlier run that stopped to ask a question before pushing anything. \
Read the approver's reply in $TASK/reply.md and start from there."
elif [ -n "${RESUME_BRANCH:-}" ]; then
    if ! git fetch -q origin "$RESUME_BRANCH" || ! git checkout -q -b "$RESUME_BRANCH" FETCH_HEAD; then
        echo "Fetching the branch $RESUME_BRANCH failed."
        exit 2
    fi
    if [ -n "${CATCHUP:-}" ]; then
        # A catch-up run (#111): the PR conflicts with the default branch.
        RESUME_NOTE=" This is a catch-up run. Your branch $RESUME_BRANCH is checked out, and your PR #$RESUME_PR \
conflicts with $DEFAULT_BRANCH. Merge origin/$DEFAULT_BRANCH into your branch with git merge, never rebase, \
and never force-push. Resolve the conflicts so both changes still do what they were for. Run make check, push, \
and comment on the PR with what you resolved and how. Change nothing else, and don't open a second PR."
    else
        RESUME_NOTE=" This run resumes earlier work: your branch $RESUME_BRANCH is checked out\
${RESUME_PR:+ and your PR is #$RESUME_PR}. Read your handoff note on the PR, then the approver's reply in \
$TASK/reply.md, and continue from there. Don't open a second PR."
    fi
fi

# Fixed text. The issue reaches the agent only as a file it reads, so nothing in it
# can change this command line.
PROMPT="You are the build agent for issue #$ISSUE in $REPO. The issue is in $TASK/issue.md. \
Your instructions are in $TASK/agent-instructions.md: read them first and follow them. \
The repository is checked out in $REPO_DIR on $DEFAULT_BRANCH. \
For GitHub writes, use the agent-gh command; run 'agent-gh help' to see what it does. \
The gh CLI isn't installed.$RESUME_NOTE"

claude -p "$PROMPT" \
    --output-format stream-json --verbose \
    --model "$MODEL" \
    --max-turns "$MAX_TURNS" \
    --max-budget-usd "$MAX_BUDGET_USD" \
    --dangerously-skip-permissions \
    --no-session-persistence \
    --disallowedTools WebSearch WebFetch \
    > "$TASK/events.jsonl" 2> "$TASK/claude.err"
code=$?

# Claude Code can exit 0 after a failed model request, so the result event decides.
jq -c 'select(.type == "result")' "$TASK/events.jsonl" 2>/dev/null | tail -n 1 > "$TASK/result.json"
echo "Claude Code exited $code."
if [ ! -s "$TASK/result.json" ]; then
    echo "No result event. Last lines of its error output:"
    tail -n 20 "$TASK/claude.err"
fi
exit "$code"
