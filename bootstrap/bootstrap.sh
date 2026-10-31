#!/usr/bin/env bash
# bootstrap.sh — Apply secure-agent-workflow's repo controls to one repo.
#
#   bash bootstrap/bootstrap.sh danjamk/myrepo --dry-run
#   bash bootstrap/bootstrap.sh danjamk/myrepo
#   bash bootstrap/bootstrap.sh danjamk/myrepo --checks deploy-preview
#   bash bootstrap/bootstrap.sh danjamk/myrepo --update-gate <sha>
#
# Idempotent: each setting is read, compared with what bootstrap wants, and
# written only if it differs. After writing, every setting is read back and
# compared again, so a setting GitHub refuses fails the run instead of passing
# silently. A second run reports no changes.
#
# What it sets (spec 0001, issues #4, #5 and #16):
#   ruleset   protect-default on the default branch: no force-push, no deletion,
#             linear history, PR required, the gate's checks plus --checks
#             required, each pinned to GitHub Actions
#   merge     squash only, auto-merge allowed, branches deleted on merge
#   actions   GitHub-owned actions plus allowed-actions.txt, SHA pinning required,
#             read-only GITHUB_TOKEN, Actions cannot create or approve PRs
#   forks     public: approval before any external contributor's fork PR runs
#             workflows; private: fork PR workflows off
#   scanning  public only: secret scanning and push protection
#   envs      preview from PR runs, staging from the default branch, production
#             from the production branch; the old dev environment is retired
#   labels    agent:ready, agent:stop, agent:blocked
#   files     files/ templates (CODEOWNERS and the gate callers, pinned to a
#             commit of GATE_REPO), written through one PR from the
#             bootstrap/managed-files branch, because the default branch needs
#             a PR. A file without the bootstrap marker is never overwritten.
#             The tier map is copied once, if the repo has none
#
# Runs as the caller's gh identity, which needs admin on the repo. A human runs
# this, never the agent: the agent App has no administration permission.

set -euo pipefail

REPO=""
CHECKS=""
CHECKS_SET=false
DRY_RUN=false
UPDATE_GATE=""

while [ $# -gt 0 ]; do
    case "$1" in
        --checks)      CHECKS="${2:-}"; CHECKS_SET=true; shift 2 ;;
        --dry-run)     DRY_RUN=true; shift ;;
        --update-gate) UPDATE_GATE="${2:-}"; shift 2 ;;
        -*)            echo "Unknown flag: $1"; exit 1 ;;
        *)             REPO="$1"; shift ;;
    esac
done

if [ -z "$REPO" ]; then
    echo "Usage: bootstrap.sh <owner>/<repo> [--dry-run] [--checks a,b] [--update-gate <sha>]"
    exit 1
fi

HERE="$(cd "$(dirname "$0")" && pwd)"
GH=gh
command -v ghw >/dev/null 2>&1 && GH=ghw

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

RULESET_NAME="protect-default"
FILES_BRANCH="bootstrap/managed-files"
MARKER="Managed by secure-agent-workflow bootstrap"
# The repo whose reusable workflows the callers in files/ use. A fork changes
# it here and in allowed-actions.txt.
GATE_REPO="danjamk/secure-agent-workflow"
# Check names the callers produce: "<caller job> / <reusable job>". Always
# required; --checks adds to them.
GATE_CHECKS="checks / check,checks / dependency-scan,checks / secret-scan,checks / code-scan,checks / misconfig-scan,checks / workflow-lint,tier / tier-check"
OWNER="${REPO%/*}"
VISIBILITY=$($GH api "repos/$REPO" --jq .visibility)
DEFAULT_BRANCH=$($GH api "repos/$REPO" --jq .default_branch)
CHANGES=0
QUEUE=()

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
    GATE_CHECKS="$GATE_CHECKS" RULESET_NAME="$RULESET_NAME" CURRENT="$WORK/current.json" \
    python3 > "$WORK/desired.json" <<'PY'
import json, os

current = json.load(open(os.environ["CURRENT"]))
gate = os.environ["GATE_CHECKS"].split(",")

if os.environ["CHECKS_SET"] == "true":
    extra = [c for c in os.environ["CHECKS"].split(",") if c]
else:
    # No --checks: keep the extra checks the ruleset already requires, so a
    # re-run doesn't silently drop them.
    extra = [
        c["context"]
        for r in current.get("rules", [])
        if r["type"] == "required_status_checks"
        for c in r["parameters"]["required_status_checks"]
    ]
# The gate's checks are always required, so no flag can drop them.
checks = list(dict.fromkeys(gate + extra))

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
        dependency_alerts
    fi
}

dependency_alerts() {
    # The gate's dependency review needs the dependency graph. On a personal
    # account, enabling Dependabot alerts is the API call that turns it on;
    # without it dependency review fails with "not supported on this repository".
    local what="scanning: Dependabot alerts (turns on the dependency graph)"
    if $GH api "repos/$REPO/vulnerability-alerts" --silent >/dev/null 2>&1; then
        [ "$MODE" = apply ] && printf '  =  %s\n' "$what"
        return 0
    fi
    CHANGES=$((CHANGES + 1))
    printf '  ~  %s\n       vulnerability-alerts: disabled -> enabled\n' "$what"
    if [ "$MODE" = apply ] && [ "$DRY_RUN" = false ]; then
        $GH api -X PUT "repos/$REPO/vulnerability-alerts" --silent
    fi
}

# environment NAME PATTERN — the environment, deployable only from refs matching
# PATTERN (fnmatch; GitHub matches it against the run's GITHUB_REF).
environment() {
    local env=$1 pattern=$2 what policies id
    sync "environment $env" \
        "repos/$REPO/environments/$env" PUT "repos/$REPO/environments/$env" \
        '{"deployment_branch_policy":{"protected_branches":false,"custom_branch_policies":true}}'

    # A named-branch policy, because "protected branches" isn't documented to
    # cover rulesets. Policies have no update call, so stale ones are deleted
    # and ours created.
    what="environment $env: deploys from $pattern only"
    # gh prints a 404's body on stdout, so only trust the output on success.
    policies=""
    if $GH api "repos/$REPO/environments/$env/deployment-branch-policies" \
        --jq '[.branch_policies[] | "\(.type):\(.name)"] | sort | join(",")' \
        > "$WORK/policies.txt" 2>/dev/null; then
        policies=$(cat "$WORK/policies.txt")
    fi
    if [ "$policies" = "branch:$pattern" ]; then
        [ "$MODE" = apply ] && printf '  =  %s\n' "$what"
        return 0
    fi
    CHANGES=$((CHANGES + 1))
    printf '  ~  %s\n' "$what"
    printf '       branch policies: %s -> branch:%s\n' "${policies:-none}" "$pattern"
    if [ "$MODE" = apply ] && [ "$DRY_RUN" = false ]; then
        for id in $($GH api "repos/$REPO/environments/$env/deployment-branch-policies" --jq \
            ".branch_policies[] | select(.type != \"branch\" or .name != \"$pattern\") | .id"); do
            $GH api -X DELETE "repos/$REPO/environments/$env/deployment-branch-policies/$id" --silent
        done
        case ",$policies," in
            *",branch:$pattern,"*) ;;
            *) $GH api -X POST "repos/$REPO/environments/$env/deployment-branch-policies" \
                   -f name="$pattern" -f type=branch --silent ;;
        esac
    fi
}

# retire_environment NAME — delete an environment bootstrap used to create,
# but only if nothing was ever deployed to it.
retire_environment() {
    local env=$1 count
    $GH api "repos/$REPO/environments/$env" --silent >/dev/null 2>&1 || return 0
    count=$($GH api "repos/$REPO/deployments?environment=$env&per_page=1" --jq length)
    if [ "$count" != 0 ]; then
        [ "$MODE" = apply ] && printf '  !  environment %s has deployments; left in place\n' "$env"
        return 0
    fi
    CHANGES=$((CHANGES + 1))
    printf '  ~  environment %s: removed (replaced by preview and staging, no deployments)\n' "$env"
    if [ "$MODE" = apply ] && [ "$DRY_RUN" = false ]; then
        $GH api -X DELETE "repos/$REPO/environments/$env" --silent
    fi
}

environments() {
    # Spec 0001, Branches and environments; ADR-002 roles trust these names.
    # A pull_request run's GITHUB_REF is refs/pull/<n>/merge, so previews
    # match that, not branch names. Fork PR runs get no OIDC token, so they
    # can't reach the dev role even though the ref matches.
    environment preview 'refs/pull/*/merge'
    environment staging "$DEFAULT_BRANCH"
    # The production branch needn't exist yet; until it does, nothing deploys.
    environment production production
    retire_environment dev
}

# label NAME COLOR DESCRIPTION
label() {
    local name=$1 color=$2 description=$3 path
    path="repos/$REPO/labels/$(printf '%s' "$name" | sed 's/:/%3A/g')"
    if $GH api "$path" > "$WORK/current.json" 2>/dev/null; then
        printf '{"color":"%s","description":"%s"}' "$color" "$description" > "$WORK/desired.json"
        compare "label $name" PATCH "$path"
    else
        echo '{}' > "$WORK/current.json"
        printf '{"name":"%s","color":"%s","description":"%s"}' "$name" "$color" "$description" \
            > "$WORK/desired.json"
        compare "label $name" POST "repos/$REPO/labels"
    fi
}

labels() {
    # The orchestrator acts on these only when the repo owner applies them;
    # the outbound handler stops the agent editing them (spec 0001).
    label agent:ready   0e8a16 "Released to a build agent"
    label agent:stop    b60205 "Ends the agent run on this issue"
    label agent:blocked fbca04 "Agent is waiting for a reply from the approver"
}

# fetch_file PATH REF — print the file's content at REF; fail if it doesn't exist.
fetch_file() {
    $GH api "repos/$REPO/contents/$1?ref=$2" > "$WORK/file.json" 2>/dev/null || return 1
    python3 -c 'import base64,json,sys; sys.stdout.write(base64.b64decode(json.load(open(sys.argv[1]))["content"]).decode())' \
        "$WORK/file.json"
}

# managed_file PATH TEMPLATE — render files/TEMPLATE and compare it with PATH on
# the default branch. A difference is queued for the bootstrap PR.
managed_file() {
    local path=$1 template=$2 rendered="$WORK/files/$1"
    mkdir -p "$(dirname "$rendered")"
    sed -e "s/{{OWNER}}/$OWNER/g" -e "s|{{GATE_REPO}}|$GATE_REPO|g" -e "s/{{GATE_SHA}}/$GATE_SHA/g" \
        "$HERE/files/$template" > "$rendered"

    if fetch_file "$path" "$DEFAULT_BRANCH" > "$WORK/default-file"; then
        if cmp -s "$rendered" "$WORK/default-file"; then
            printf '  =  file %s\n' "$path"
            return 0
        fi
        if ! grep -q "$MARKER" "$WORK/default-file"; then
            # Someone else's file. Never overwrite it.
            printf '  !  file %s exists and is not managed by bootstrap; left alone. Merge in by hand:\n' "$path"
            grep -v '^#' "$rendered" | sed '/^$/d; s/^/       /'
            return 0
        fi
    else
        : > "$WORK/default-file"
    fi

    if [ -n "$OPEN_PR" ] && fetch_file "$path" "$FILES_BRANCH" > "$WORK/branch-file" \
        && cmp -s "$rendered" "$WORK/branch-file"; then
        printf '  =  file %s: pending in PR #%s\n' "$path" "$OPEN_PR"
        return 0
    fi

    CHANGES=$((CHANGES + 1))
    printf '  ~  file %s\n' "$path"
    diff -u "$WORK/default-file" "$rendered" | tail -n +3 | sed 's/^/       /' || true
    QUEUE+=("$path")
}

# seed_file PATH SOURCE — copy SOURCE into the repo if PATH doesn't exist there.
# No marker: the repo owns the file from then on and bootstrap never updates it.
seed_file() {
    local path=$1 source=$2
    if fetch_file "$path" "$DEFAULT_BRANCH" >/dev/null; then
        printf '  =  file %s: present, owned by the repo\n' "$path"
        return 0
    fi
    if [ -n "$OPEN_PR" ] && fetch_file "$path" "$FILES_BRANCH" >/dev/null; then
        printf '  =  file %s: pending in PR #%s\n' "$path" "$OPEN_PR"
        return 0
    fi
    CHANGES=$((CHANGES + 1))
    printf '  ~  file %s: copied once, the repo owns it after\n' "$path"
    mkdir -p "$(dirname "$WORK/files/$path")"
    cp "$source" "$WORK/files/$path"
    QUEUE+=("$path")
}

# publish_files — commit queued files to FILES_BRANCH and open or reuse the PR.
publish_files() {
    local path sha number
    if ! $GH api "repos/$REPO/git/ref/heads/$FILES_BRANCH" >/dev/null 2>&1; then
        sha=$($GH api "repos/$REPO/git/ref/heads/$DEFAULT_BRANCH" --jq .object.sha)
        $GH api -X POST "repos/$REPO/git/refs" \
            -f ref="refs/heads/$FILES_BRANCH" -f sha="$sha" --silent
    fi
    for path in "${QUEUE[@]}"; do
        sha=""
        if $GH api "repos/$REPO/contents/$path?ref=$FILES_BRANCH" --jq .sha \
            > "$WORK/sha.txt" 2>/dev/null; then
            sha=$(cat "$WORK/sha.txt")
        fi
        FILE="$WORK/files/$path" FILE_PATH="$path" BRANCH="$FILES_BRANCH" SHA="$sha" \
        python3 > "$WORK/put.json" <<'PY'
import base64, json, os
body = {
    "message": f"chore: update {os.environ['FILE_PATH']} from bootstrap",
    "content": base64.b64encode(open(os.environ["FILE"], "rb").read()).decode(),
    "branch": os.environ["BRANCH"],
}
if os.environ["SHA"]:
    body["sha"] = os.environ["SHA"]
print(json.dumps(body))
PY
        $GH api -X PUT "repos/$REPO/contents/$path" --input "$WORK/put.json" --silent
    done

    if [ -n "$OPEN_PR" ]; then
        echo "  Updated PR #$OPEN_PR."
        return 0
    fi
    number=$($GH api -X POST "repos/$REPO/pulls" \
        -f title="chore: bootstrap managed files" \
        -f head="$FILES_BRANCH" -f base="$DEFAULT_BRANCH" \
        -f body="Files managed by secure-agent-workflow bootstrap. Re-running bootstrap updates this PR. Merge it to finish bootstrapping." \
        --jq .number)
    echo "  Opened PR #$number: https://github.com/$REPO/pull/$number"
}

files() {
    managed_file .github/CODEOWNERS CODEOWNERS
    managed_file .github/workflows/gate.yml gate.yml
    managed_file .github/workflows/tier-check.yml tier-check.yml
    seed_file standards/tier-map.yml "$HERE/../standards/tier-map.yml"
}

# resolve_gate_sha — the GATE_REPO commit the callers pin. --update-gate takes
# a commit on GATE_REPO's default branch. Otherwise keep the repo's current pin
# (the open bootstrap PR's first, then the default branch's), or on a first run
# use GATE_REPO's default branch head.
resolve_gate_sha() {
    local gate_branch status ref
    gate_branch=$($GH api "repos/$GATE_REPO" --jq .default_branch)
    if [ -n "$UPDATE_GATE" ]; then
        if ! $GH api "repos/$GATE_REPO/commits/$UPDATE_GATE" --jq .sha > "$WORK/sha.txt" 2>/dev/null; then
            echo "--update-gate: $UPDATE_GATE is not a commit in $GATE_REPO."
            exit 1
        fi
        GATE_SHA=$(cat "$WORK/sha.txt")
        # Only a commit on the default branch: a branch commit nobody reviewed
        # can't become every consumer's gate.
        status=$($GH api "repos/$GATE_REPO/compare/$GATE_SHA...$gate_branch" --jq .status)
        if [ "$status" != ahead ] && [ "$status" != identical ]; then
            echo "--update-gate: $GATE_SHA is not on $GATE_REPO's $gate_branch."
            exit 1
        fi
        GATE_SOURCE="--update-gate"
        return 0
    fi
    for ref in ${OPEN_PR:+"$FILES_BRANCH"} "$DEFAULT_BRANCH"; do
        # A missing file fails the pipeline; that's "no pin here", not an error.
        GATE_SHA=$( { fetch_file .github/workflows/gate.yml "$ref" 2>/dev/null || true; } \
            | sed -n "s|.*$GATE_REPO/.github/workflows/gate-checks.yml@\([0-9a-f]\{40\}\).*|\1|p" | head -1)
        if [ -n "$GATE_SHA" ]; then
            GATE_SOURCE="kept from $ref"
            return 0
        fi
    done
    GATE_SHA=$($GH api "repos/$GATE_REPO/commits/$gate_branch" --jq .sha)
    GATE_SOURCE="$GATE_REPO $gate_branch"
}

run_all() {
    ruleset
    merge_settings
    actions_policy
    fork_policy
    scanning
    environments
    labels
    # Files land through a PR, so there's nothing to read back until it merges.
    if [ "$MODE" = apply ]; then
        files
    fi
}

# --- Run ---

OPEN_PR=$($GH api "repos/$REPO/pulls?head=$OWNER:$FILES_BRANCH&state=open" --jq '.[0].number // empty')
resolve_gate_sha

echo ""
echo "Repo:       $REPO ($VISIBILITY)"
echo "Mode:       $([ "$DRY_RUN" = true ] && echo "dry run" || echo apply)"
echo "Gate:       $GATE_REPO@${GATE_SHA:0:7} ($GATE_SOURCE)"
echo ""

MODE=apply
run_all
if [ "$DRY_RUN" = false ] && [ "${#QUEUE[@]}" -gt 0 ]; then
    publish_files
fi

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
