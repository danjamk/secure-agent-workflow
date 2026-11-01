# Sourced, not run. Defines saw_assume_role, which takes an AWS role through
# GitHub OIDC and exports its temporary credentials into the calling shell.
# Used by read-params.sh (the broker action) and the daily credential check.
#
#   saw_assume_role <role-arn> <session-name>
#
# Needs a job with `permissions: id-token: write`, curl, jq and the AWS CLI,
# all on GitHub's Ubuntu runners. The credentials exist only in the calling
# process and its children; nothing is written to GITHUB_ENV.

saw_assume_role() {
    local role=$1 session=$2 oidc creds
    if [ -z "$role" ]; then
        echo "FAIL  AWS_ROLE_ARN is empty. Run: broker.sh add-repo ${GITHUB_REPOSITORY:-<owner>/<repo>}" >&2
        return 1
    fi
    if [ -z "${ACTIONS_ID_TOKEN_REQUEST_URL:-}" ]; then
        echo "FAIL  no OIDC token available; the job needs permissions: id-token: write" >&2
        return 1
    fi
    # The ARN isn't secret, but it holds the AWS account ID, and a public
    # repo's logs are public.
    echo "::add-mask::$role"

    oidc=$(curl -sSf -H "Authorization: bearer $ACTIONS_ID_TOKEN_REQUEST_TOKEN" \
        "$ACTIONS_ID_TOKEN_REQUEST_URL&audience=sts.amazonaws.com" | jq -r .value)
    echo "::add-mask::$oidc"

    creds=$(aws sts assume-role-with-web-identity --role-arn "$role" \
        --role-session-name "$session" --web-identity-token "$oidc" \
        --query 'Credentials.[AccessKeyId,SecretAccessKey,SessionToken]' --output text)
    read -r AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY AWS_SESSION_TOKEN <<<"$creds"
    echo "::add-mask::$AWS_SECRET_ACCESS_KEY"
    echo "::add-mask::$AWS_SESSION_TOKEN"
    export AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY AWS_SESSION_TOKEN
}
