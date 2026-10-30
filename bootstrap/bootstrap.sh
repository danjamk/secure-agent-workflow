#!/usr/bin/env bash
# bootstrap.sh — Apply secure-agent-workflow's repo controls to one repo.
#
#   bash bootstrap/bootstrap.sh danjamk/myrepo --dry-run
#   bash bootstrap/bootstrap.sh danjamk/myrepo
#   bash bootstrap/bootstrap.sh danjamk/myrepo --checks gate-checks,tier-check
#
# Idempotent: each setting is read, compared with what bootstrap wants, and
# written only if it differs. After writing, every setting is read back and
# compared again, so a setting GitHub refuses fails the run instead of passing
# silently. A second run reports no changes.
#
# What it sets (spec 0001, issue #4):
#   ruleset   protect-default on the default branch: no force-push, no deletion,
#             linear history, PR required, required checks pinned to GitHub Actions
#   merge     squash only, auto-merge allowed, branches deleted on merge
#   actions   GitHub-owned actions plus allowed-actions.txt, SHA pinning required,
#             read-only GITHUB_TOKEN, Actions cannot create or approve PRs
#   forks     public: approval before any external contributor's fork PR runs
#             workflows; private: fork PR workflows off
#   scanning  public only: secret scanning and push protection
#
# Runs as the caller's gh identity, which needs admin on the repo. A human runs
# this, never the agent: the agent App has no administration permission.

set -euo pipefail

REPO=""
CHECKS=""
CHECKS_SET=false
DRY_RUN=false

while [ $# -gt 0 ]; do
    case "$1" in
        --checks)  CHECKS="${2:-}"; CHECKS_SET=true; shift 2 ;;
        --dry-run) DRY_RUN=true; shift ;;
        -*)        echo "Unknown flag: $1"; exit 1 ;;
        *)         REPO="$1"; shift ;;
    esac
done

if [ -z "$REPO" ]; then
    echo "Usage: bootstrap.sh <owner>/<repo> [--dry-run] [--checks a,b]"
    exit 1
fi

HERE="$(cd "$(dirname "$0")" && pwd)"
GH=gh
command -v ghw >/dev/null 2>&1 && GH=ghw

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

RULESET_NAME="protect-default"
VISIBILITY=$($GH api "repos/$REPO" --jq .visibility)
CHANGES=0

# --- Compare and apply ---

# compare LABEL METHOD PATH — desired is in $WORK/desired.json, current in
# $WORK/current.json. In "apply" mode a difference is written; in "check" mode
# it is only counted.
compare() {
    local label=$1 method=$2 path=$3
    if python3 "$HERE/diff.py" "$WORK/desired.json" "$WORK/current.json" > "$WORK/diff.txt"; then
        [ "$MODE" = apply ] && printf '  =  %s\n' "$label"
        return 0
    fi
    CHANGES=$((CHANGES + 1))
    printf '  ~  %s\n' "$label"
    sed 's/^/       /' "$WORK/diff.txt"
    if [ "$MODE" = apply ] && [ "$DRY_RUN" = false ]; then
        $GH api -X "$method" "$path" --input "$WORK/desired.json" --silent
    fi
}

# sync LABEL GET_PATH METHOD WRITE_PATH DESIRED_JSON
sync() {
    local label=$1 get=$2 method=$3 put=$4 desired=$5
    local attempt=1
    printf '%s' "$desired" > "$WORK/desired.json"
    while true; do
        # Some endpoints 404 or 409 until a prerequisite is set (selected-actions
        # before allowed_actions is "selected"). Treat that as "nothing set yet".
        $GH api "$get" > "$WORK/current.json" 2>/dev/null || echo '{}' > "$WORK/current.json"
        # Reading back right after a write can return the old values for a few
        # seconds (seen on GET /repos). Retry before calling a setting refused.
        if [ "$MODE" != check ] || [ "$attempt" -ge 5 ]; then
            break
        fi
        if python3 "$HERE/diff.py" "$WORK/desired.json" "$WORK/current.json" >/dev/null; then
            break
        fi
        attempt=$((attempt + 1))
        sleep 2
    done
    compare "$label" "$method" "$put"
}

# --- Settings ---

ruleset() {
    local actions_id existing
    # Required checks are pinned to the GitHub Actions app, so a check run or
    # status from any other App (the agent's included) cannot satisfy them.
    actions_id=$($GH api apps/github-actions --jq .id)
    existing=$($GH api "repos/$REPO/rulesets" --jq \
        ".[] | select(.name == \"$RULESET_NAME\") | .id" | head -1)
    if [ -n "$existing" ]; then
        $GH api "repos/$REPO/rulesets/$existing" > "$WORK/current.json"
    else
        echo '{}' > "$WORK/current.json"
    fi

    ACTIONS_ID="$actions_id" CHECKS="$CHECKS" CHECKS_SET="$CHECKS_SET" \
    RULESET_NAME="$RULESET_NAME" CURRENT="$WORK/current.json" \
    python3 > "$WORK/desired.json" <<'PY'
import json, os

current = json.load(open(os.environ["CURRENT"]))

if os.environ["CHECKS_SET"] == "true":
    checks = [c for c in os.environ["CHECKS"].split(",") if c]
else:
    # No --checks: keep whatever checks the ruleset already requires, so a
    # re-run doesn't silently drop the gate.
    checks = [
        c["context"]
        for r in current.get("rules", [])
        if r["type"] == "required_status_checks"
        for c in r["parameters"]["required_status_checks"]
    ]

rules = [
    {"type": "non_fast_forward"},
    {"type": "deletion"},
    {"type": "required_linear_history"},
    {
        "type": "pull_request",
        "parameters": {
            # Zero: approvals come through the tier check, which accepts only
            # Dan's login (ADR-003). GitHub won't let an author approve their own
            # PR, so a non-zero count would block Dan's own PRs.
            "required_approving_review_count": 0,
            "dismiss_stale_reviews_on_push": False,
            "require_code_owner_review": False,
            "require_last_push_approval": False,
            "required_review_thread_resolution": False,
        },
    },
]
if checks:
    rules.append({
        "type": "required_status_checks",
        "parameters": {
            "strict_required_status_checks_policy": False,
            "required_status_checks": [
                {"context": c, "integration_id": int(os.environ["ACTIONS_ID"])}
                for c in checks
            ],
        },
    })

print(json.dumps({
    "name": os.environ["RULESET_NAME"],
    "target": "branch",
    "enforcement": "active",
    "conditions": {"ref_name": {"include": ["~DEFAULT_BRANCH"], "exclude": []}},
    # No bypass actors: the ruleset binds the repo admin too.
    "bypass_actors": [],
    "rules": rules,
}))
PY

    if [ -n "$existing" ]; then
        compare "ruleset $RULESET_NAME" PUT "repos/$REPO/rulesets/$existing"
    else
        compare "ruleset $RULESET_NAME" POST "repos/$REPO/rulesets"
    fi

    if [ "$MODE" = apply ]; then
        $GH api "repos/$REPO/rulesets" --jq \
            ".[] | select(.name != \"$RULESET_NAME\") | \"  !  other ruleset left in place: \(.name)\""
    fi
}

merge_settings() {
    sync "merge: squash only, auto-merge, delete merged branches" \
        "repos/$REPO" PATCH "repos/$REPO" \
        '{"allow_squash_merge":true,"allow_merge_commit":false,"allow_rebase_merge":false,"allow_auto_merge":true,"delete_branch_on_merge":true}'
}

actions_policy() {
    local patterns
    # grep exits 1 when the file holds only comments; that is an empty list.
    patterns=$( { grep -v '^[[:space:]]*\(#\|$\)' "$HERE/allowed-actions.txt" || true; } \
        | python3 -c 'import json,sys; print(json.dumps([l.strip() for l in sys.stdin]))')

    sync "actions: selected actions only, SHA pinning required" \
        "repos/$REPO/actions/permissions" PUT "repos/$REPO/actions/permissions" \
        '{"enabled":true,"allowed_actions":"selected","sha_pinning_required":true}'
    sync "actions: GitHub-owned plus allowed-actions.txt" \
        "repos/$REPO/actions/permissions/selected-actions" PUT "repos/$REPO/actions/permissions/selected-actions" \
        "{\"github_owned_allowed\":true,\"verified_allowed\":false,\"patterns_allowed\":$patterns}"
    sync "actions: read-only GITHUB_TOKEN, cannot approve PRs" \
        "repos/$REPO/actions/permissions/workflow" PUT "repos/$REPO/actions/permissions/workflow" \
        '{"default_workflow_permissions":"read","can_approve_pull_request_reviews":false}'
}

fork_policy() {
    if [ "$VISIBILITY" = public ]; then
        sync "forks: approval for every external contributor" \
            "repos/$REPO/actions/permissions/fork-pr-contributor-approval" \
            PUT "repos/$REPO/actions/permissions/fork-pr-contributor-approval" \
            '{"approval_policy":"all_external_contributors"}'
    else
        sync "forks: fork PR workflows off" \
            "repos/$REPO/actions/permissions/fork-pr-workflows-private-repos" \
            PUT "repos/$REPO/actions/permissions/fork-pr-workflows-private-repos" \
            '{"run_workflows_from_fork_pull_requests":false}'
    fi
}

scanning() {
    # Secret scanning is free on public repos and paid on private ones; the
    # merge gate runs gitleaks for private repos instead.
    if [ "$VISIBILITY" = public ]; then
        sync "scanning: secret scanning and push protection" \
            "repos/$REPO" PATCH "repos/$REPO" \
            '{"security_and_analysis":{"secret_scanning":{"status":"enabled"},"secret_scanning_push_protection":{"status":"enabled"}}}'
    fi
}

run_all() {
    ruleset
    merge_settings
    actions_policy
    fork_policy
    scanning
}

# --- Run ---

echo ""
echo "Repo:       $REPO ($VISIBILITY)"
echo "Mode:       $([ "$DRY_RUN" = true ] && echo "dry run" || echo apply)"
echo ""

MODE=apply
run_all

echo ""
if [ "$CHANGES" -eq 0 ]; then
    echo "No changes."
    exit 0
fi
if [ "$DRY_RUN" = true ]; then
    echo "$CHANGES setting(s) would change. Nothing was written."
    exit 0
fi

# --- Verify, don't assume ---

APPLIED=$CHANGES
CHANGES=0
MODE=check
echo "Applied $APPLIED change(s). Reading back:"
run_all
if [ "$CHANGES" -eq 0 ]; then
    echo "  All settings match."
else
    echo ""
    echo "$CHANGES setting(s) did not take. GitHub may not support them on this plan or visibility."
    exit 1
fi
