#!/usr/bin/env bash
# broker.sh — Deploy the AWS side of the credential broker (ADR-002, ADR-006).
#
#   AWS_PROFILE=saw bash deploy/broker/aws/broker.sh account [--dry-run]
#   AWS_PROFILE=saw bash deploy/broker/aws/broker.sh add-repo danjamk/myrepo [--dry-run]
#   AWS_PROFILE=saw bash deploy/broker/aws/broker.sh setup danjamk/myrepo [--dry-run]
#   AWS_PROFILE=saw bash deploy/broker/aws/broker.sh set danjamk/myrepo <credential> [--dry-run]
#   AWS_PROFILE=saw bash deploy/broker/aws/broker.sh status danjamk/myrepo
#   AWS_PROFILE=saw bash deploy/broker/aws/broker.sh factory danjamk/secure-agent-workflow [--dry-run]
#   AWS_PROFILE=saw bash deploy/broker/aws/broker.sh set-factory danjamk/secure-agent-workflow <name> [--dry-run]
#
# setup, set and status run deploy/credentials/credentials.py (ADR-007): setup
# walks through every missing credential, set checks one and stores it, status
# reports on the broker and every credential.
#
# account   Once per AWS account: the GitHub OIDC provider (or reuse of an
#           existing one) and the OpenTofu state bucket. Stack saw-broker.
# add-repo  Once per consumer repo: the preview and staging roles, trusting
#           only that repo's preview and staging environments by GitHub's
#           immutable owner and repo IDs. Stack saw-broker-<repo>. Writes each
#           role's ARN into the matching GitHub environment as the secret AWS_ROLE_ARN,
#           plus the variable AWS_REGION.
# factory   Once, on the repo holding the orchestrator: the role that deploys it
#           to the factory account, trusting only that repo's factory
#           environment. Stack saw-broker-factory. Writes AWS_ROLE_ARN and
#           AWS_REGION into that environment, and stores the deploy settings
#           from .env.local and the Keychain.
# set-factory  Stores one value at /<repo>/factory/deploy/<name>. The token goes
#           here, not through `set`, which refuses factory account credentials.
#
# --dry-run creates a CloudFormation change set, prints it and deletes it,
# and says what it would set in GitHub. Nothing is changed.
#
# AWS_PROFILE must be set, so the script never falls back to default
# credentials. Runs as the caller's gh identity, which needs admin on the repo
# to set environment variables. A human runs this, never the agent.
#
# The prod role comes with the production release path (#32).

set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../../.." && pwd)"
REGION="${AWS_REGION:-us-east-1}"
ACCOUNT_STACK=saw-broker
FACTORY_STACK=saw-broker-factory
FACTORY_TOKEN=cloudflare-deploy-token
FACTORY_SETTINGS="cloudflare-account-id approver-login allowed-repos orchestrator-url agent-app-id"

CMD="${1:-}"
shift || true

# Credential commands live with the manifest and checkers (ADR-007).
case "$CMD" in
    setup|set|status) exec python3 "$HERE/../../credentials/credentials.py" "$CMD" "$@" ;;
esac

REPO=""
NAME=""
DRY_RUN=false
while [ $# -gt 0 ]; do
    case "$1" in
        --dry-run) DRY_RUN=true; shift ;;
        -*)        echo "Unknown flag: $1"; exit 1 ;;
        *)         if [ -z "$REPO" ]; then REPO="$1"; else NAME="$1"; fi; shift ;;
    esac
done

usage() {
    echo "Usage: AWS_PROFILE=<profile> broker.sh account [--dry-run]"
    echo "       AWS_PROFILE=<profile> broker.sh add-repo <owner>/<repo> [--dry-run]"
    echo "       AWS_PROFILE=<profile> broker.sh setup <owner>/<repo> [--dry-run] [--manifest FILE]"
    echo "       AWS_PROFILE=<profile> broker.sh set <owner>/<repo> <credential> [--dry-run] [--manifest FILE]"
    echo "       AWS_PROFILE=<profile> broker.sh status <owner>/<repo> [--manifest FILE]"
    echo "       AWS_PROFILE=<profile> broker.sh factory <owner>/<repo> [--dry-run]"
    echo "       AWS_PROFILE=<profile> broker.sh set-factory <owner>/<repo> <name> [--dry-run]"
    exit 1
}

[ -n "${AWS_PROFILE:-}" ] || { echo "Set AWS_PROFILE. This script never uses default credentials."; exit 1; }

aws_() { aws --region "$REGION" "$@"; }

CALLER="$(aws_ sts get-caller-identity --query Arn --output text)"
echo "AWS: $CALLER, $REGION (profile $AWS_PROFILE)"
$DRY_RUN && echo "Dry run: nothing will change."

# deploy STACK TEMPLATE [Key=Value ...]
deploy() {
    local stack="$1" template="$2"
    shift 2
    local params=()
    [ $# -gt 0 ] && params=(--parameter-overrides "$@")
    if $DRY_RUN; then
        aws_ cloudformation deploy --stack-name "$stack" --template-file "$template" \
            --capabilities CAPABILITY_NAMED_IAM --no-execute-changeset --no-fail-on-empty-changeset \
            ${params[@]+"${params[@]}"} >/dev/null
        local cs
        cs="$(aws_ cloudformation list-change-sets --stack-name "$stack" \
            --query 'Summaries[0].ChangeSetName' --output text)"
        if [ "$cs" = None ] || [ -z "$cs" ]; then
            echo "No changes for $stack."
            return
        fi
        echo "Change set for $stack:"
        aws_ cloudformation describe-change-set --stack-name "$stack" --change-set-name "$cs" \
            --query 'Changes[].ResourceChange.[Action,LogicalResourceId,ResourceType,Replacement]' \
            --output table
        aws_ cloudformation delete-change-set --stack-name "$stack" --change-set-name "$cs"
        # A first-time dry run leaves an empty stack in REVIEW_IN_PROGRESS; remove it.
        local status
        status="$(aws_ cloudformation describe-stacks --stack-name "$stack" \
            --query 'Stacks[0].StackStatus' --output text)"
        if [ "$status" = REVIEW_IN_PROGRESS ]; then
            aws_ cloudformation delete-stack --stack-name "$stack"
        fi
    else
        aws_ cloudformation deploy --stack-name "$stack" --template-file "$template" \
            --capabilities CAPABILITY_NAMED_IAM --no-fail-on-empty-changeset \
            ${params[@]+"${params[@]}"}
    fi
}

output() {
    aws_ cloudformation describe-stacks --stack-name "$1" \
        --query "Stacks[0].Outputs[?OutputKey=='$2'].OutputValue" --output text
}

cmd_account() {
    local existing=""
    # Reuse a provider this stack didn't create; AWS allows one per URL.
    if ! aws_ cloudformation describe-stack-resource --stack-name "$ACCOUNT_STACK" \
            --logical-resource-id GitHubOidcProvider >/dev/null 2>&1; then
        existing="$(aws_ iam list-open-id-connect-providers \
            --query "OpenIDConnectProviderList[?ends_with(Arn, '/token.actions.githubusercontent.com')].Arn" \
            --output text)"
    fi
    if [ -n "$existing" ]; then
        echo "Reusing the existing GitHub OIDC provider."
    else
        echo "Creating the GitHub OIDC provider."
    fi
    deploy "$ACCOUNT_STACK" "$HERE/account.yml" "ExistingOidcProviderArn=$existing"
    $DRY_RUN || echo "State bucket: $(output "$ACCOUNT_STACK" StateBucketName)"
}

# Sets owner_id and repo_id for REPO, and stops if its OIDC subjects won't match
# the roles' trust policies.
read_repo_ids() {
    aws_ cloudformation describe-stacks --stack-name "$ACCOUNT_STACK" >/dev/null 2>&1 \
        || { echo "Stack $ACCOUNT_STACK not found. Run: broker.sh account"; exit 1; }

    local ids created
    ids="$(gh api "repos/$REPO" --jq '"\(.owner.id) \(.id) \(.created_at)"')"
    read -r owner_id repo_id created <<<"$ids"
    echo "Repo: $REPO (owner id $owner_id, repo id $repo_id, created $created)"

    # Repos created before 2026-07-15 use repo:<owner>/<repo>:... subjects
    # unless opted in to immutable IDs; the trust policy only matches IDs.
    if [[ "$created" < 2026-07-15 ]]; then
        echo "Warning: repo predates GitHub's immutable OIDC subjects. Opt it in under"
        echo "Settings > Actions > OIDC, or the roles will refuse every job."
    fi
    local custom
    custom="$(gh api "repos/$REPO/actions/oidc/customization/sub" --jq '.use_default' 2>/dev/null || echo true)"
    if [ "$custom" = false ]; then
        echo "The repo has a custom OIDC subject template; the roles expect the default. Stopping."
        exit 1
    fi
}

cmd_add_repo() {
    [[ "$REPO" =~ ^[A-Za-z0-9-]+/[A-Za-z0-9._-]+$ ]] || usage
    local owner="${REPO%/*}" name="${REPO#*/}"
    local stack="saw-broker-${name//[^A-Za-z0-9-]/-}"
    [ ${#name} -le 52 ] || { echo "Repo name over 52 characters; IAM role names would exceed 64."; exit 1; }

    local owner_id repo_id
    read_repo_ids

    local env
    for env in preview staging; do
        gh api "repos/$REPO/environments/$env" >/dev/null 2>&1 \
            || { echo "Environment $env missing. Run bootstrap/bootstrap.sh $REPO first."; exit 1; }
    done

    deploy "$stack" "$HERE/repo.yml" "Owner=$owner" "OwnerId=$owner_id" "RepoName=$name" "RepoId=$repo_id"

    if $DRY_RUN; then
        echo "Would set AWS_ROLE_ARN and AWS_REGION=$REGION in environments preview and staging."
        return
    fi
    # The ARN isn't secret, but as a secret it is masked, which keeps the
    # account ID out of public repos' logs.
    gh secret set AWS_ROLE_ARN --repo "$REPO" --env preview --body "$(output "$stack" PreviewRoleArn)"
    gh variable set AWS_REGION --repo "$REPO" --env preview --body "$REGION"
    gh secret set AWS_ROLE_ARN --repo "$REPO" --env staging --body "$(output "$stack" StagingRoleArn)"
    gh variable set AWS_REGION --repo "$REPO" --env staging --body "$REGION"
    echo "Done: saw-$name-preview and saw-$name-staging; AWS_ROLE_ARN set in both environments."
}

# store_factory NAME VALUE — the value goes over stdin, so it never appears in a
# process list. SecureString even for settings that aren't secret: the deploy job
# masks whatever it reads, which keeps them out of a public repo's logs.
store_factory() {
    local name=$1 value=$2 path="/${REPO#*/}/factory/deploy/$1"
    if $DRY_RUN; then
        echo "Would store $path."
        return
    fi
    printf '%s' "$value" | aws_ ssm put-parameter --name "$path" --type SecureString \
        --overwrite --value file:///dev/stdin >/dev/null
    aws_ ssm add-tags-to-resource --resource-type Parameter --resource-id "$path" --tags \
        "Key=saw:set-at,Value=$(date -u +%Y-%m-%dT%H:%M:%SZ)" "Key=saw:set-by,Value=$CALLER"
    if [ "$name" = "$FACTORY_TOKEN" ]; then
        aws_ ssm add-tags-to-resource --resource-type Parameter --resource-id "$path" --tags \
            "Key=saw:dashboard-name,Value=saw-factory-$name"
    fi
    echo "Stored $path."
}

# A value from .env.local, read in a subshell so its other values stay out of
# this one.
env_local() {
    (
        set -a
        # shellcheck disable=SC1091
        . "$ROOT/.env.local"
        printenv "$1"
    ) || true
}

factory_setting() {
    case "$1" in
        cloudflare-account-id) env_local CLOUDFLARE_ACCOUNT_ID ;;
        approver-login)        env_local APPROVER_LOGIN ;;
        allowed-repos)         env_local ALLOWED_REPOS ;;
        orchestrator-url)      env_local ORCHESTRATOR_URL ;;
        agent-app-id)
            security find-generic-password -s secure-agent-workflow \
                -a "${APP_SLUG:-danjamk-build-agent}:app-id" -w 2>/dev/null || true
            ;;
    esac
}

cmd_factory() {
    [[ "$REPO" =~ ^[A-Za-z0-9-]+/[A-Za-z0-9._-]+$ ]] || usage
    local owner="${REPO%/*}" name="${REPO#*/}"
    [ -f "$ROOT/.env.local" ] || { echo "No .env.local at $ROOT."; exit 1; }

    local setting value
    for setting in $FACTORY_SETTINGS; do
        value="$(factory_setting "$setting")"
        [ -n "$value" ] || { echo "No value for $setting. See deploy/README.md, Factory deploys."; exit 1; }
    done

    local owner_id repo_id
    read_repo_ids
    gh api "repos/$REPO/environments/factory" >/dev/null 2>&1 \
        || { echo "Environment factory missing. Run bootstrap/bootstrap.sh $REPO first."; exit 1; }

    deploy "$FACTORY_STACK" "$HERE/factory.yml" "Owner=$owner" "OwnerId=$owner_id" "RepoName=$name" "RepoId=$repo_id"

    if $DRY_RUN; then
        echo "Would set AWS_ROLE_ARN and AWS_REGION=$REGION in environment factory."
    else
        gh secret set AWS_ROLE_ARN --repo "$REPO" --env factory --body "$(output "$FACTORY_STACK" FactoryRoleArn)"
        gh variable set AWS_REGION --repo "$REPO" --env factory --body "$REGION"
        echo "Done: saw-$name-factory; AWS_ROLE_ARN set in environment factory."
    fi
    for setting in $FACTORY_SETTINGS; do
        store_factory "$setting" "$(factory_setting "$setting")"
    done
    echo "Next: broker.sh set-factory $REPO $FACTORY_TOKEN"
}

cmd_set_factory() {
    [[ "$REPO" =~ ^[A-Za-z0-9-]+/[A-Za-z0-9._-]+$ ]] && [ -n "$NAME" ] || usage
    case " $FACTORY_TOKEN $FACTORY_SETTINGS " in
        *" $NAME "*) ;;
        *) echo "$NAME isn't a factory deploy setting: $FACTORY_TOKEN $FACTORY_SETTINGS"; exit 1 ;;
    esac

    if [ "$NAME" = "$FACTORY_TOKEN" ]; then
        echo "Create in:  your factory account's Cloudflare dashboard"
        echo "Name it:    saw-factory-$NAME"
        echo "Grant:      Account: Workers Scripts Edit, Account Settings Read. That account only, no zones"
    fi

    local value
    if [ -t 0 ]; then
        read -rs -p "Paste $NAME (not echoed): " value
        echo
    else
        value="$(cat)"
    fi
    [ -n "$value" ] || { echo "FAIL  empty value; nothing stored"; exit 1; }

    if [ "$NAME" = "$FACTORY_TOKEN" ]; then
        local checked identity expected
        if ! checked="$(printf '%s' "$value" | "$HERE/../../credentials/checks/cloudflare" workers)"; then
            grep -v '^IDENTITY' <<<"$checked" || true
            echo "Nothing stored."
            exit 1
        fi
        grep -v '^IDENTITY' <<<"$checked" || true
        identity="$(awk '$1 == "IDENTITY" { print $2 }' <<<"$checked")"
        expected="$(env_local CLOUDFLARE_ACCOUNT_ID)"
        if [ -z "$expected" ] || [ "$identity" != "$expected" ]; then
            echo "FAIL  this token doesn't belong to the factory account (CLOUDFLARE_ACCOUNT_ID in .env.local). Nothing stored."
            exit 1
        fi
        echo "PASS  belongs to the factory account"
    fi
    store_factory "$NAME" "$value"
}

case "$CMD" in
    account)     cmd_account ;;
    add-repo)    cmd_add_repo ;;
    factory)     cmd_factory ;;
    set-factory) cmd_set_factory ;;
    *)           usage ;;
esac
