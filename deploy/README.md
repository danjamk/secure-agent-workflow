# Deploy

Deploys a consumer repo to Cloudflare with credentials from a GitHub OIDC broker (ADR-002, ADR-007), and applies its infrastructure as OpenTofu (ADR-006). Nothing here runs in the agent's sandbox, and no deploy credential is stored in GitHub.

| Part | Status |
| --- | --- |
| AWS broker: OIDC provider, state bucket, preview and staging roles (`broker/aws/`) | Built (#17) |
| Credentials: manifest, `set`, `status`, Cloudflare checker (`credentials/`) | Built (#53) |
| Daily credential check | #55 |
| Broker action and Cloudflare deploy template | #18 |
| OpenTofu plan and apply | #49 |
| Prod role | #32 |

## AWS broker

Two CloudFormation templates, deployed by `broker/aws/broker.sh` with a named AWS profile. A human runs it, never the agent.

```bash
AWS_PROFILE=<profile> bash deploy/broker/aws/broker.sh account --dry-run
AWS_PROFILE=<profile> bash deploy/broker/aws/broker.sh account
AWS_PROFILE=<profile> bash deploy/broker/aws/broker.sh add-repo <owner>/<repo> --dry-run
AWS_PROFILE=<profile> bash deploy/broker/aws/broker.sh add-repo <owner>/<repo>
```

| Command | Stack | Creates |
| --- | --- | --- |
| `account`, once per AWS account | `saw-broker` | The GitHub OIDC provider, or reuses one that exists (AWS allows one per URL). The S3 bucket `saw-tfstate-<account-id>` for OpenTofu state: versioned, encrypted, public access blocked, TLS only. The bucket is kept if the stack is deleted |
| `add-repo`, once per consumer repo | `saw-broker-<repo>` | Roles `saw-<repo>-preview` and `saw-<repo>-staging`. Writes each ARN into the matching GitHub environment as the secret `AWS_ROLE_ARN`, and `AWS_REGION` as a variable |

`--dry-run` creates a CloudFormation change set, prints it and deletes it. The script refuses to run without `AWS_PROFILE`, so it never falls back to default credentials. The region defaults to `us-east-1`; set `AWS_REGION` to change it.

### What each role can do

| Role | Assumable by | Parameter Store | State in `saw-tfstate-<account-id>` |
| --- | --- | --- | --- |
| Preview | `repo:<owner>@<owner-id>/<repo>@<repo-id>:environment:preview` only | `/<repo>/dev/preview/*` | List and read `<repo>/dev/`. Plans run with `-lock=false` |
| Staging | `...:environment:staging` only | `/<repo>/dev/preview/*` and `/<repo>/dev/staging/*` | Read, write and delete `<repo>/dev/`, including the lock file |

- **The subject uses GitHub's immutable IDs.** A repo deleted and recreated under the same name gets a new ID, so it can't assume the old repo's roles. `add-repo` looks the IDs up, warns about a repo created before 2026-07-15 (those need opting in to the ID format), and stops if the repo has a custom OIDC subject template.
- **Decryption only through SSM.** `kms:Decrypt` is allowed only with `kms:ViaService` set to SSM, so the roles can't decrypt anything else with the key.
- **The ARN is stored as a secret only for masking.** It isn't sensitive, but it contains the account ID, and public repos' logs are public.

## Credentials

Every credential a consumer repo needs is declared in the repo, checked before it is stored, and reported on (ADR-007). `credentials/` holds the tool, the checkers and an example manifest.

| Part | Path |
| --- | --- |
| Manifest, in the consumer repo | `infra/credentials.yml`, tier 2. Example: `credentials/credentials.example.yml`, which lists the fields |
| Tool | `credentials/credentials.py`, run through `broker.sh set` and `broker.sh status` |
| Checkers | `credentials/checks/<system>`, one executable per system |

```bash
AWS_PROFILE=<profile> bash deploy/broker/aws/broker.sh setup <owner>/<repo>
AWS_PROFILE=<profile> bash deploy/broker/aws/broker.sh set <owner>/<repo> <name> --dry-run
AWS_PROFILE=<profile> bash deploy/broker/aws/broker.sh set <owner>/<repo> <name>
AWS_PROFILE=<profile> bash deploy/broker/aws/broker.sh status <owner>/<repo>
```

Names follow `standards/credentials.md`: `<system>-<role>-<kind>` in the manifest, and `<repo>-<target>-<name>` for the token in the provider's dashboard.

**`setup`** is the usual way in. It lists every declared credential and skips the ones stored and passing. For each missing or failing one, it prints the account to create it in, the dashboard name, the permissions and the parameter path. Then it prompts for the value, checks it and stores it, the same as `set`. Enter on an empty prompt skips one. It ends with `status`. It needs a terminal.

**`set`** stores one credential. It reads the entry from the manifest on the default branch and prints its purpose and the permissions to grant. It then prompts for the value without echoing it and runs the system's checker. It stores the value only if every check passes. A value piped on stdin is read instead of prompting.

- The checker reports which account the credential belongs to. The first credential for a system and target records it as `<system>-account-id`, after you confirm the account's name. Later credentials must match it.
- A credential from your factory account is refused. The factory account is any `<SYSTEM>_ACCOUNT_ID`, such as `CLOUDFLARE_ACCOUNT_ID`, in this repo's `.env.local` or the environment.
- Tags on the parameter record `saw:set-at`, `saw:set-by`, `saw:checked-at`, `saw:expires`, `saw:checker` and `saw:dashboard-name`.
- A system with no checker can be stored after you type `yes`. `status` reports it as unchecked.
- `--dry-run` runs every check and stores nothing. `--manifest FILE` reads a local manifest instead of the default branch.

**`status`** prints one line per check, naming each credential and its dashboard token, at PASS, WARN or FAIL, and exits 1 on any FAIL:

- the broker: both stacks, each role's trust subject, `AWS_ROLE_ARN` in each environment;
- each declared credential: missing, placeholder, check failing, wrong account, expired (FAIL); expiring within 14 days, older than `rotate_days`, no checker (WARN);
- each stored parameter the manifest doesn't declare (WARN).

### Parameter layout

`/<repo>/<target>/<exposure>/<name>`. The roles read by prefix, so a new credential needs no IAM change:

| Path | Read by | Holds |
| --- | --- | --- |
| `/<repo>/dev/preview/*` | Preview, staging | Credentials PR code may see: the Cloudflare deploy and read-only tokens, `cloudflare-account-id` |
| `/<repo>/dev/staging/*` | Staging | Credentials only merged code may use: the Cloudflare infrastructure token |
| `/<repo>/prod/prod/*` | Prod (#32) | Production credentials |

### Cloudflare tokens

Create each one in the dev target's Cloudflare account, under My Profile > API Tokens > Create Custom Token, named `<repo>-dev-<credential>`, such as `agent-testbed-dev-cloudflare-deploy-token`. Under Account Resources, choose that account only. Add no zone permissions. `broker.sh setup` prints all of this for each token.

| Credential | Exposure | Permissions | `check` |
| --- | --- | --- | --- |
| `cloudflare-deploy-token` | preview | Account: Workers Scripts Edit, Account Settings Read | `workers` |
| `cloudflare-read-token` | preview | Account: Workers Scripts Read, Workers KV Storage Read, D1 Read, Account Settings Read. Add R2 and Queues Read if the app uses them | `workers kv d1` |
| `cloudflare-infra-token` | staging | Account: Workers KV Storage Edit, D1 Edit, Account Settings Read. Add R2 and Queues Edit if the app uses them | `kv d1` |

The checker confirms each token is active and reaches exactly one account. Unless `check` includes `zones`, it confirms the token can't read any zone's DNS records or settings. A token with Workers Scripts permission can list the account's zone names, so listing alone is reported as INFO. It also confirms the token can list each resource named in `check`. It can't confirm a token lacks extra permissions: reading a token's permissions needs a broader token. The table above is the checklist for that. Account-owned tokens aren't supported yet.

### Adding a system

1. Add the entries to the consumer's `infra/credentials.yml`, named `<system>-<role>-<kind>`.
2. If the system has an API that can confirm a key, add `credentials/checks/<system>`. The contract:
   - It receives the manifest's `check` words as arguments and reads the secret on stdin.
   - It writes `PASS`, `FAIL` or `INFO` lines, plus optional `EXPIRES <YYYY-MM-DD>` and `IDENTITY <id> <label>`.
   - It exits non-zero on any FAIL and never prints the secret.

   The tool discards a checker's output if the secret appears in it. `checks/cloudflare` is the example to copy.
3. Store the values with `broker.sh setup`.

### Tests

`broker/aws/test/broker-test.yml` and `cross-repo-test.yml` are copied into two testbeds' `.github/workflows/`. They assume each role from each environment and check every allow and deny above. A refusal passes only on `AccessDenied`, so an empty secret can't pass as a refusal.

## Other options for a fork

| Option | What changes |
| --- | --- |
| Two AWS accounts, dev and prod | Run `account` and `add-repo` in each, with each account's profile. The templates don't change |
| Vault or OpenBao | Replace `broker/aws/` with JWT auth roles bound to the same subjects. The broker action in #18 is the only caller |
| GCP Workload Identity or Azure federated credentials | Same: one folder replaces `broker/aws/` |
| GitHub environment secrets | No broker at all. Simplest, but the tokens are long-lived and stored in GitHub (ADR-002) |
