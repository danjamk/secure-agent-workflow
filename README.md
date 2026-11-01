# secure-agent-workflow

Tooling and standards for letting coding agents build with little supervision, while nothing reaches production unchecked.

The agent can't change the controls: they live in the sandbox, GitHub permissions and cloud credentials, not in instructions or settings files the agent can read and edit.

**Overview:** [the one-page picture](https://danjamk.github.io/secure-agent-workflow/) shows the topology, the workflow and how a project adopts it. It describes the full design, including the parts not built yet. Source: [`docs/index.html`](docs/index.html).

**Status:** the agent's GitHub App, bootstrap and the merge gate (checks, scanners, tier check) are built and tested end to end on testbed repos. The orchestrator, sandbox, production deploy, PR audit and red-team runs are not built yet.

## How it works

1. A human writes the spec, plan and ADRs, and turns the plan into issues grouped in waves.
2. Dispatching a wave labels its issues `agent:ready`. Each one starts a build agent in a fresh, locked-down sandbox, in dependency order and within a concurrency cap and spend budget.
3. The agent works on its own branch and opens a PR, which gets a preview deploy. It can't touch workflows, settings or `main`.
4. A merge gate routes the PR by what it touches. Low-risk changes merge on green checks; risky ones wait for a human.
5. `main` deploys to staging in the dev target. Production, in the prod target, is a versioned release PR from `main` into a `production` branch, approved by a human, and only that deploy can get production credentials. The release path is designed and gets built after the path to staging works.

## Accounts

The platform and the apps it builds run in separate accounts:

| Term | What it is | Holds |
| --- | --- | --- |
| Factory account | The platform's own cloud account. Never a deploy target | Orchestrator, sandboxes, operator console |
| Dev target | Where the app deploys previews and staging. One account per provider the app uses, such as a Cloudflare account, an Auth0 tenant or a database project | Preview and staging deploys |
| Prod target | Where the app deploys production, again one account per provider | Production deploys |
| Broker account | The key store. Its dev and prod stores can share one AWS account or use two | OIDC roles, Parameter Store, OpenTofu state |

A Cloudflare token that can deploy Workers can change every Worker in its account. That's why the factory account is never a deploy target: an app's deploy credentials can't reach the orchestrator.

## Pieces

| Folder | What it holds | Status |
| --- | --- | --- |
| `bootstrap/` | One command that applies rulesets, environments and gate wiring to a repo. Also the agent's GitHub App manifest and scripts | Built |
| `gate/` and `.github/workflows/` | Reusable merge-gate workflows: checks, scanners, tier check, PR audit | Built, except the PR audit |
| `standards/` | ADR template, agent instructions, issue template, planning agent instructions, tier map | Built |
| `orchestrator/` | Cloudflare Worker that runs agents in sandboxes, with credentials kept outside | Not started |
| `deploy/` | Deploy template with a GitHub OIDC credential broker | AWS broker, credential checks, and Cloudflare previews and staging built; OpenTofu and production not started |
| `redteam/` | Attacks the controls must stop | Not started |

## Adapting it

v1 runs on Cloudflare and AWS. Each part lives in its own folder and states what it expects from the others, so you can rewrite one part without touching the rest. There is no configuration layer for this; you change the code.

| Part | v1 choice | Other options | Folder |
| --- | --- | --- | --- |
| Agent identity | GitHub App ([ADR-001](docs/adr/ADR-001-agent-github-app-identity.md)) | Machine user account; a GitHub org on Team, which adds push rulesets | `bootstrap/` |
| Sandbox | Cloudflare Sandbox SDK ([ADR-004](docs/adr/ADR-004-cloudflare-sandbox.md)) | E2B; Docker Sandboxes on your own host; containers under gVisor or Kata; GitHub Actions runners on public repos | `orchestrator/` |
| Egress and credential proxy | Worker outbound handlers | Envoy or Squid with an allowlist in front of any container host | `orchestrator/` |
| Agent CLI | Not yet chosen | Any agent CLI that runs headless, such as Claude Code or Codex | `orchestrator/` |
| Scanners | Free tools; GitHub's own on public repos | GitHub Advanced Security, or a commercial scanner | `gate/` |
| PR audit models | Builder and reviewer from different model families | Any model API, including a self-hosted model | `gate/` |
| Credential broker | GitHub OIDC to AWS IAM and Parameter Store, with separate preview, staging and prod roles in one account or two ([ADR-002](docs/adr/ADR-002-oidc-credential-broker.md)) | Vault or OpenBao; GCP Workload Identity with Secret Manager; Azure federated credentials with Key Vault; GitHub environment secrets, which is simplest but long-lived | `deploy/` |
| Deploy target | Cloudflare Workers | Any target the deploy job can reach with brokered credentials | `deploy/` |

GitHub doesn't swap out. Bootstrap, the gate and the agent identity all depend on GitHub rulesets, Apps, Actions and OIDC.

Whatever you replace, keep the property the design depends on: the agent cannot change the control.

## Read first

- [Spec 0001: secure build-agent workflow](docs/specs/0001-secure-build-agent-workflow.md)
- [Sandbox bake-off](docs/research/sandbox-bakeoff.md)
- Decisions: [ADR-001](docs/adr/ADR-001-agent-github-app-identity.md) · [ADR-002](docs/adr/ADR-002-oidc-credential-broker.md) · [ADR-003](docs/adr/ADR-003-tier-check-reusable-workflow.md) · [ADR-004](docs/adr/ADR-004-cloudflare-sandbox.md)
