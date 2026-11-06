#!/bin/bash
# run-agent.sh — Runs the build agent on one issue (#9).
#
# The Worker writes the issue and the agent instructions to /workspace/task first,
# and passes the rest in the environment: REPO, ISSUE, DEFAULT_BRANCH, BOT_NAME,
# BOT_EMAIL, MODEL, MAX_TURNS, MAX_BUDGET_USD. The container holds no credentials:
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

# Fixed text. The issue reaches the agent only as a file it reads, so nothing in it
# can change this command line.
PROMPT="You are the build agent for issue #$ISSUE in $REPO. The issue is in $TASK/issue.md. \
Your instructions are in $TASK/agent-instructions.md: read them first and follow them. \
The repository is checked out in $REPO_DIR on $DEFAULT_BRANCH. \
For GitHub writes, use the agent-gh command; run 'agent-gh help' to see what it does. \
The gh CLI isn't installed."

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
