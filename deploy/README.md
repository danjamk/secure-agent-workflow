# Deploy

Deploys a consumer repo to Cloudflare with credentials from a GitHub OIDC broker (ADR-002), and applies its infrastructure as OpenTofu (ADR-006). Nothing here runs in the agent's sandbox, and no deploy credential is stored in GitHub.

| Part | Status |
| --- | --- |
| AWS broker: OIDC provider, state bucket, preview and staging roles (`broker/aws/`) | Built (#17) |
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
| Preview | `repo:<owner>@<owner-id>/<repo>@<repo-id>:environment:preview` only | `/<repo>/dev/cloudflare-deploy-token`, `cloudflare-read-token`, `cloudflare-account-id` | List and read `<repo>/dev/`. Plans run with `-lock=false` |
| Staging | `...:environment:staging` only | All of `/<repo>/dev/*` | Read, write and delete `<repo>/dev/`, including the lock file |

- **The subject uses GitHub's immutable IDs.** A repo deleted and recreated under the same name gets a new ID, so it can't assume the old repo's roles. `add-repo` looks the IDs up, warns about a repo created before 2026-07-15 (those need opting in to the ID format), and stops if the repo has a custom OIDC subject template.
- **Decryption only through SSM.** `kms:Decrypt` is allowed only with `kms:ViaService` set to SSM, so the roles can't decrypt anything else with the key.
- **The ARN is stored as a secret only for masking.** It isn't sensitive, but it contains the account ID, and public repos' logs are public.

### Parameter names

The operator puts the tokens in, never the agent or a workflow:

| Parameter | Type | Read by |
| --- | --- | --- |
| `/<repo>/dev/cloudflare-deploy-token` | SecureString | Preview, staging |
| `/<repo>/dev/cloudflare-read-token` | SecureString | Preview, staging |
| `/<repo>/dev/cloudflare-infra-token` | SecureString | Staging |
| `/<repo>/dev/cloudflare-account-id` | String | Preview, staging |

### Tests

`broker/aws/test/broker-test.yml` and `cross-repo-test.yml` are copied into two testbeds' `.github/workflows/`. They assume each role from each environment and check every allow and deny above. A refusal passes only on `AccessDenied`, so an empty secret can't pass as a refusal.

## Other options for a fork

| Option | What changes |
| --- | --- |
| Two AWS accounts, dev and prod | Run `account` and `add-repo` in each, with each account's profile. The templates don't change |
| Vault or OpenBao | Replace `broker/aws/` with JWT auth roles bound to the same subjects. The broker action in #18 is the only caller |
| GCP Workload Identity or Azure federated credentials | Same: one folder replaces `broker/aws/` |
| GitHub environment secrets | No broker at all. Simplest, but the tokens are long-lived and stored in GitHub (ADR-002) |
