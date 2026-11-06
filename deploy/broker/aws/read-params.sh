#!/usr/bin/env bash
# The broker action's one step (action.yml). Takes the job's role through OIDC,
# reads each named parameter, masks it and hands it to the job's later steps as
# an environment variable. The role's AWS credentials stay in this process.
#
# Environment, set by action.yml:
#   ROLE        the environment's AWS_ROLE_ARN secret
#   AWS_REGION  the environment's AWS_REGION variable
#   PARAMETERS  one per line or space-separated: <target>/<exposure>/<name>,
#               read from /<repo>/<target>/<exposure>/<name>. A trailing ? makes
#               one optional: if it doesn't exist, its variable is left unset.
#               Any other failure to read it still fails the step
#
# Each value becomes the variable named after <name>, upper-cased with dashes
# as underscores: dev/preview/cloudflare-deploy-token -> CLOUDFLARE_DEPLOY_TOKEN.
set -euo pipefail

HERE=$(cd "$(dirname "$0")" && pwd)
# shellcheck source=assume-role.sh
. "$HERE/assume-role.sh"

repo_name=${GITHUB_REPOSITORY#*/}
read -r -a names <<<"$(echo "$PARAMETERS" | tr '\n' ' ')"
if [ "${#names[@]}" -eq 0 ]; then
    echo "FAIL  no parameters named" >&2
    exit 1
fi
for name in "${names[@]}"; do
    if ! [[ $name =~ ^[a-z]+/[a-z]+/[a-z0-9-]+\??$ ]]; then
        echo "FAIL  '$name' isn't <target>/<exposure>/<name>, such as dev/preview/cloudflare-deploy-token" >&2
        exit 1
    fi
done

saw_assume_role "$ROLE" "broker-$GITHUB_RUN_ID"

for name in "${names[@]}"; do
    optional=false
    if [[ $name == *\? ]]; then
        optional=true
        name=${name%\?}
    fi
    path="/$repo_name/$name"
    if ! value=$(aws ssm get-parameter --name "$path" --with-decryption \
            --query Parameter.Value --output text 2>"${RUNNER_TEMP:-/tmp}/broker-error"); then
        # Only a parameter that doesn't exist is skipped. Access denied still fails.
        if $optional && grep -q ParameterNotFound "${RUNNER_TEMP:-/tmp}/broker-error"; then
            echo "Skipped $path: optional, and not stored"
            continue
        fi
        echo "FAIL  can't read $path as this role. Store it with broker.sh setup, or check the role can read that exposure" >&2
        exit 1
    fi
    while IFS= read -r line; do
        [ -n "$line" ] && echo "::add-mask::$line"
    done <<<"$value"
    var=$(basename "$name" | tr 'a-z-' 'A-Z_')
    delim="SAW_$(openssl rand -hex 12)"
    {
        echo "$var<<$delim"
        echo "$value"
        echo "$delim"
    } >>"$GITHUB_ENV"
    echo "Read $path into $var"
done
