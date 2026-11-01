#!/usr/bin/env bash
# broker.sh — Deploy the AWS side of the credential broker (ADR-002, ADR-006).
#
#   AWS_PROFILE=saw bash deploy/broker/aws/broker.sh account [--dry-run]
#   AWS_PROFILE=saw bash deploy/broker/aws/broker.sh add-repo danjamk/myrepo [--dry-run]
#
# account   Once per AWS account: the GitHub OIDC provider (or reuse of an
#           existing one) and the OpenTofu state bucket. Stack saw-broker.
# add-repo  Once per consumer repo: the preview and staging roles, trusting
#           only that repo's preview and staging environments by GitHub's
#           immutable owner and repo IDs. Stack saw-broker-<repo>. Writes each
#           role's ARN into the matching GitHub environment as the secret AWS_ROLE_ARN,
#           plus the variable AWS_REGION.
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
REGION="${AWS_REGION:-us-east-1}"
ACCOUNT_STACK=saw-broker

CMD="${1:-}"
shift || true
REPO=""
DRY_RUN=false
while [ $# -gt 0 ]; do
    case "$1" in
        --dry-run) DRY_RUN=true; shift ;;
        -*)        echo "Unknown flag: $1"; exit 1 ;;
        *)         REPO="$1"; shift ;;
    esac
done

usage() {
    echo "Usage: AWS_PROFILE=<profile> broker.sh account [--dry-run]"
    echo "       AWS_PROFILE=<profile> broker.sh add-repo <owner>/<repo> [--dry-run]"
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
        [ "$status" = REVIEW_IN_PROGRESS ] && aws_ cloudformation delete-stack --stack-name "$stack"
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

cmd_add_repo() {
    [[ "$REPO" =~ ^[A-Za-z0-9-]+/[A-Za-z0-9._-]+$ ]] || usage
    local owner="${REPO%/*}" name="${REPO#*/}"
    local stack="saw-broker-${name//[^A-Za-z0-9-]/-}"
    [ ${#name} -le 52 ] || { echo "Repo name over 52 characters; IAM role names would exceed 64."; exit 1; }

    aws_ cloudformation describe-stacks --stack-name "$ACCOUNT_STACK" >/dev/null 2>&1 \
        || { echo "Stack $ACCOUNT_STACK not found. Run: broker.sh account"; exit 1; }

    local ids owner_id repo_id created
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

case "$CMD" in
    account)  cmd_account ;;
    add-repo) cmd_add_repo ;;
    *)        usage ;;
esac
