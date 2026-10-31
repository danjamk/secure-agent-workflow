# ADR-006: Project infrastructure is OpenTofu applied by the pipeline, and Workers stay in wrangler

Status: Proposed · Date: 2026-10-31

## Context

Agents will need infrastructure beyond Worker code: DNS records, Access applications, buckets, databases, queues, and on other clouds anything those clouds offer. The spec requires that nothing reaches an environment except through the pipeline, and the sandbox holds no cloud credentials (ADR-004). Deploy credentials come only from the broker (ADR-002).

`wrangler.jsonc` covers one Worker and its bindings, applied on deploy. It has no plan step and no drift detection. It leaves resources behind when a binding is removed, and it manages nothing outside a Worker, such as DNS or Access.

The reference build targets Cloudflare. Forks will target AWS, GCP or Azure.

Preview jobs run a PR's build scripts with dev credentials (spec 0001, Branches and environments). Whatever the preview credential can do, an agent's PR can do in the dev account.

## Decision

Infrastructure falls into three layers:

| Layer | Examples | Written by | Applied by |
| --- | --- | --- | --- |
| Platform foundation | Cloud accounts, the OIDC broker, the orchestrator, the agent GitHub App | Dan, in this repo | Dan, through `bootstrap/` and `deploy/broker/`. Never an agent or a consumer pipeline |
| Project infrastructure | DNS, Access applications, buckets, databases, queues, AWS resources | The agent, as OpenTofu in the consumer's `infra/` | The pipeline |
| Worker config | `wrangler.jsonc`, bindings, D1 migrations | The agent | The deploy job |

**Where things live**

- Project infrastructure is OpenTofu in `infra/`, with one root per account (`infra/dev/`, `infra/prod/`) and shared modules in `infra/modules/`.
- Workers and their bindings stay in `wrangler.jsonc`. OpenTofu does not manage Worker scripts.
- A resource a binding points to (D1, KV, R2, queue) is created by OpenTofu and referenced by ID in `wrangler.jsonc`. A binding without an ID fails the gate, because newer wrangler versions can create the resource on deploy, outside the plan.
- Provider versions are pinned in the committed `.terraform.lock.hcl`. The OpenTofu binary is pinned by SHA-256 in `gate/tools.txt`, like the scanners.

**Pipeline**

| Event | Job | Credential | Does |
| --- | --- | --- | --- |
| PR | Plan, in `preview` | Preview role: read-only Cloudflare token, read-only state | `tofu plan` for `infra/dev/`, posted as a PR comment. Never applies |
| Merge to `main` | Staging deploy, in `staging` | Staging role: infrastructure token, read-write dev state | Apply `infra/dev/`, then D1 migrations, then the Worker |
| Merged release | Production deploy, in `production` | Prod role | The same sequence for `infra/prod/`. The release PR shows the prod plan (build order step 3) |
| Daily schedule | Drift check, in `staging` | Staging role, plan only | Opens an issue when the plan is not empty |

Previews never apply infrastructure or migrations. A preview Worker version uses the deployed Worker's bindings, so applying either would change staging. A PR that changes `infra/` or a migration gets a plan and no preview.

**Credentials.** ADR-002's dev role splits in two, so the job that runs PR code never reads the token that can change infrastructure:

| Role | Trusts only | Reads |
| --- | --- | --- |
| Preview | `environment:preview` | Cloudflare deploy token (Workers only), Cloudflare read-only token, dev state read-only |
| Staging | `environment:staging` | Cloudflare deploy token, Cloudflare infrastructure token, dev state read-write |
| Prod | `environment:production` | Prod tokens, prod state read-write |

**State** lives in one S3 bucket in the broker's AWS account, created by the broker template. The key is `<repo>/<account>/terraform.tfstate`. Versioning is on, public access is blocked, and locking uses S3 lock files (OpenTofu 1.10 and later), so no DynamoDB table is needed.

**Stateful resources.** A plan that deletes or replaces a database, bucket, KV namespace or queue fails the gate, unless the approver authored the PR. The check reads `tofu show -json` and compares resource types against a list in `deploy/`. It is the same rule as tier 3: the agent can't remove data, and Dan can.

**The agent's side.** In the sandbox the agent runs `tofu fmt -check` and `tofu validate`, with `tofu init -backend=false`. It can't plan, because it holds no credentials. It reads the plan from the PR comment and pushes fixes. The egress allowlist adds `registry.opentofu.org` and the GitHub release download hosts that providers come from.

**Tiers.** `infra/**`, `**/*.tf`, `**/*.tofu` and `**/.terraform.lock.hcl` are tier 2, so a new provider needs approval like any dependency.

## Alternatives considered

- **wrangler only.** Nothing to add, but Cloudflare only, with no plan to approve, no drift detection, and resources left behind when bindings are removed. DNS and Access stay manual.
- **Terraform.** The same language and providers. HashiCorp's BSL license is the reason to prefer OpenTofu; a fork can switch with little change.
- **Pulumi.** TypeScript, which matches the orchestrator. Adds a language runtime to the gate, and its default state backend is Pulumi Cloud. Programs are general code, so the plan is the only reliable view of a change.
- **CDK or CloudFormation for project infrastructure.** AWS only. CloudFormation stays the choice for the broker itself, which has to exist before any OpenTofu state does.
- **OpenTofu managing Workers too.** One tool, but it fights wrangler over the same scripts and loses wrangler's preview versions.
- **The agent applying infrastructure from the sandbox with scoped credentials.** Faster feedback, but it puts cloud credentials in the sandbox (ADR-004).

## Consequences

- Every change to an environment goes through a PR whose plan Dan sees and approves at tier 2. Manual dashboard changes show up as drift issues.
- The broker has three roles instead of two (ADR-002 is revised to match), and each Cloudflare account needs three tokens: deploy, read-only and infrastructure.
- The plan job runs agent-written OpenTofu with read-only dev credentials. Providers and external data sources execute code during a plan, which is why the credentials are read-only and new providers need approval.
- PRs that change infrastructure or migrations get no preview.
- A fork on another cloud keeps the pipeline and changes the providers in `infra/` and the role permissions in the broker. A fork that prefers Terraform swaps the binary.
