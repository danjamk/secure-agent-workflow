# Deploy

Deploys a consumer repo to Cloudflare with credentials from a GitHub OIDC broker (ADR-002, ADR-007), and applies its infrastructure as OpenTofu (ADR-006). Nothing here runs in the agent's sandbox, and no deploy credential is stored in GitHub.

| Part | Status |
| --- | --- |
| AWS broker: OIDC provider, state bucket, preview and staging roles (`broker/aws/`) | Built (#17) |
| Credentials: manifest, `set`, `status`, Cloudflare checker (`credentials/`) | Built (#53) |
| Daily credential check (`credentials/daily-check.sh`, `bootstrap/files/credential-check.yml`) | Built (#55) |
| Broker action and Cloudflare previews and staging (`broker/aws/action.yml`, `cloudflare/`, `bootstrap/files/deploy.yml`) | Built (#18) |
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

### Broker action

Deploy jobs get credentials through one composite action, `broker/aws/action.yml`. Its contract: parameter names in, masked values out.

```yaml
- uses: ./.saw/deploy/broker/aws        # this repo, checked out at the pinned commit
  with:
    role-arn: ${{ secrets.AWS_ROLE_ARN }}
    aws-region: ${{ vars.AWS_REGION }}
    parameters: |
      dev/preview/cloudflare-deploy-token
      dev/preview/cloudflare-account-id
```

- Each name is `<target>/<exposure>/<name>`, read from `/<repo>/<target>/<exposure>/<name>`. Each value is masked in the log, then set for the job's later steps as `<NAME>`, upper case with dashes as underscores: `CLOUDFLARE_DEPLOY_TOKEN`.
- The role's AWS credentials stay inside the action's step. Only the named values leave it.
- A parameter the role can't read fails the step and names the path.
- The action runs from the checkout rather than as `owner/repo/path@sha`, so bootstrap's allowed-actions policy needs no entry for it. GitHub allowed `./.saw/deploy/broker/aws` under "selected actions only" on the testbed.
- `assume-role.sh` holds the OIDC exchange. The daily credential check uses it too, because it needs AWS credentials rather than parameter values.
- The job that runs the action must declare the environment itself. A reusable workflow gets an environment's secrets empty, which #55 found.

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

### Daily check

Bootstrap installs `.github/workflows/credential-check.yml` in each consumer. It runs once a day at 12:17 UTC, and can be run from the Actions tab. It checks out this repo at the pinned commit and runs `credentials/daily-check.sh`, which takes the staging role through OIDC and runs `credentials.py check --issue`.

- It runs as the staging role, so it checks the dev target's credentials only. Prod credentials stay with `status` until the prod role exists (#32). It skips the broker checks, which the role can't read.
- It opens one issue labeled `credentials` on any FAIL, or when a credential expires within 14 days or is past `rotate_days`. Later runs update the issue, comment when the problems change, and close it when everything passes. A credential with no checker or an undeclared parameter is listed but doesn't open the issue on its own.
- Every value is masked in the log before a checker runs. Account names and IDs are replaced in the issue, which is public on a public repo.
- The job uses the `staging` environment with `deployment: false`, so it creates no deployment record. Staging's deployment history stays a list of real deploys, which rollback reads (ADR-009).
- A repo without `infra/credentials.yml` skips the job without touching staging or AWS.
- It's a plain workflow in the consumer, not a call to a reusable workflow. The first testbed run called one: the job got staging's `AWS_REGION` variable, but its `AWS_ROLE_ARN` secret arrived empty. A called workflow gets environment secrets only when the caller passes `secrets: inherit`, which hands it every repo secret and which the gate's zizmor scan refuses. The broker action in #18 has the same constraint: the job that reads `AWS_ROLE_ARN` must be in the consumer's own workflow.
- The staging role needs `ssm:ListTagsForResource` for the rotation warning. Repos added before #55 get it from `broker.sh add-repo <owner>/<repo>`.

Tested on `danjamk/agent-testbed`, 2026-11-01, run from the Actions tab:

| Run | Result |
| --- | --- |
| All three tokens valid | 3 pass, no issue, no staging deployment record |
| Read token overwritten with an invalid value | Issue opened: 1 failing, account details removed |
| Infra token set to `placeholder` | Same issue: title updated to 2 failing, one comment listing the change |
| Rerun with nothing changed | Body updated to the new run, no comment |
| Both restored from parameter version 1 | Issue closed with a comment |

No account ID or account name appeared in the logs or the issue.

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

## Cloudflare deploys

Bootstrap installs `.github/workflows/deploy.yml` (template: `bootstrap/files/deploy.yml`). A repo with a wrangler config gets:

| Event | Job | Result |
| --- | --- | --- |
| Any PR from the repo itself | `deploy-preview`, environment `preview` | A version of `<worker>-preview` with the alias `pr-<N>`, and its URL in one PR comment, edited on each push |
| Push to the default branch | `deploy-staging`, environment `staging` | `<worker>-staging` deployed, then `/health` must return this build's id |

PRs from forks get no preview. The first preview deploys `<worker>-preview` once, because Cloudflare only adds versions to a Worker that exists.

### What the consumer repo provides

- A `wrangler.jsonc`, `wrangler.json` or `wrangler.toml` with a `name` and `env.preview` and `env.staging` sections. Each env holds that Worker's own bindings, so preview code can't reach staging data through a binding.
- A `make build` target that writes the bundled Worker to `dist/index.js`, with no credentials. `wrangler deploy --dry-run --outdir dist --env=""` does it.
- A `/health` route returning JSON with `build` set from `env.BUILD_ID`. The deploy job sets `BUILD_ID` to `<package.json version>+<short sha>`, or `0.0.0+<short sha>` without a package.json.
- `cloudflare-deploy-token` declared in `infra/credentials.yml` and stored with `broker.sh setup`. Storing it also records `cloudflare-account-id`, which the deploy job reads too.

### Build and deploy are separate jobs

`deploy-build` runs the PR's code: `make build` and whatever it installs. It has `contents: read` and nothing else: no environment, no secrets, no OIDC token. It uploads `dist/`, the config and `package.json` as one bundle, and outputs its sha256.

The deploy jobs hold the token and run only this repo's code at the pinned commit:

1. `cloudflare/prepare.py` checks the bundle against the build job's sha256 and unpacks only regular files under `dist/`, plus the config and `package.json`. A link, an absolute path or `..` fails the job. A symlink at `dist/index.js` pointing at a runner file would otherwise upload that file as Worker code.
2. It writes a sanitized `wrangler.json`. It removes `[build]` because wrangler runs `build.command` even with `--no-bundle` (checked with wrangler 4.151.1), and `account_id` because the broker decides the account. It refuses `containers`, `site` and `assets`, which need files or tools from outside the bundle. Static assets aren't supported yet.
3. wrangler comes from `cloudflare/package-lock.json`, installed with `npm ci --ignore-scripts`. It uploads `dist/index.js` with `--no-bundle`. Framework autoconfig is off.

The deploy token can still change any Worker in the dev target account, because Cloudflare tokens can't be scoped to one Worker. Preview code runs on the dev target. Both are accepted dev-target risk (spec 0001): keep valuable data out of the dev target.

Not covered yet:

- A PR that changes infrastructure or migrations still gets a preview. ADR-006 says it should get a plan and no preview; that comes with #49 (OpenTofu plan and apply).
- Artifact attestation comes with production releases (#34).

### Results

`danjamk/agent-testbed` PR #26, 2026-11-01:

| Run | Result |
| --- | --- |
| First push | `deploy-build` passed with no OIDC token available (the testbed's `make build` fails if one is). `deploy-preview` created `agent-testbed-preview`, uploaded a version with alias `pr-26`, and posted the URL. `/health` returned `0.1.0+1a30ebb` |
| Second push | Version upload only; the same comment edited, not a second one. `/health` returned the new build |
| Broker | The local action passed "selected actions only". Both values masked; no account ID in the log |
| Preview reading the infrastructure token | Refused: the testbed's `broker-test.yml` preview job passed on the same PR |
| Staging | Pending the merge of PR #26 |

## Other options for a fork

| Option | What changes |
| --- | --- |
| Two AWS accounts, dev and prod | Run `account` and `add-repo` in each, with each account's profile. The templates don't change |
| Vault or OpenBao | Replace `broker/aws/` with JWT auth roles bound to the same subjects, and an `action.yml` with the same inputs that sets the same variables |
| GCP Workload Identity or Azure federated credentials | Same: one folder replaces `broker/aws/` |
| Another deploy target | Replace `cloudflare/` and the deploy steps in `bootstrap/files/deploy.yml`. Keep the split: build without credentials, deploy from a job that runs no repo code |
| GitHub environment secrets | No broker at all. Simplest, but the tokens are long-lived and stored in GitHub (ADR-002) |
