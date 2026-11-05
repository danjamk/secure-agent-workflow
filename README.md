# secure-agent-workflow

A secure software factory for coding agents. Agents build from approved issues with little supervision, and nothing reaches production unchecked.

The agent can't change the controls: they live in the sandbox, GitHub permissions and cloud credentials, not in instructions or settings files the agent can read and edit.

**Overview:** [the one-page picture](https://danjamk.github.io/secure-agent-workflow/) shows the topology, the workflow and how a project adopts it. It describes the full design, including the parts not built yet. Source: [`docs/index.html`](docs/index.html).

**Status:** these are built and tested end to end on testbed repos: the agent's GitHub App, bootstrap, the merge gate (checks, scanners, tier check), the AWS credential broker, daily credential checks, and Cloudflare previews and staging. This repo's own PRs go through the same gate. The orchestrator has its webhook intake, token minting and outbound policy, which is unit-tested but hasn't run against a real container yet. The sandbox, infrastructure as code, production deploys, PR audit and red-team runs are not built yet.

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
| `orchestrator/` | Cloudflare Worker that runs agents in sandboxes, with credentials kept outside | Webhook intake and token minting. No sandbox yet |
| `deploy/` | Deploy template with a GitHub OIDC credential broker | AWS broker, credential checks, and Cloudflare previews and staging built; OpenTofu and production not started |
| `redteam/` | Attacks the controls must stop | Not started |

## Adapting it

v1 runs on Cloudflare and AWS. Each part lives in its own folder and states what it expects from the others, so you can rewrite one part without touching the rest. There is no configuration layer for this; you change the code.

| Part | v1 choice | Other options | Folder |
| --- | --- | --- | --- |
| Agent identity | GitHub App ([ADR-001](docs/adr/ADR-001-agent-github-app-identity.md)) | Machine user account; a GitHub org on Team, which adds push rulesets | `bootstrap/` |
| Sandbox | Cloudflare containers ([ADR-004](docs/adr/ADR-004-cloudflare-sandbox.md)) | E2B; Docker Sandboxes on your own host; containers under gVisor or Kata; GitHub Actions runners on public repos | `orchestrator/` |
| Egress and credential proxy | Worker outbound handlers | Envoy or Squid with an allowlist in front of any container host | `orchestrator/` |
| Agent CLI | Not yet chosen | Any agent CLI that runs headless, such as Claude Code or Codex | `orchestrator/` |
| Scanners | Free tools; GitHub's own on public repos | GitHub Advanced Security, or a commercial scanner | `gate/` |
| PR audit models | Builder and reviewer from different model families | Any model API, including a self-hosted model | `gate/` |
| Credential broker | GitHub OIDC to AWS IAM and Parameter Store, with separate preview, staging and prod roles in one account or two ([ADR-002](docs/adr/ADR-002-oidc-credential-broker.md)) | Vault or OpenBao; GCP Workload Identity with Secret Manager; Azure federated credentials with Key Vault; GitHub environment secrets, which is simplest but long-lived | `deploy/` |
| Deploy target | Cloudflare Workers | Any target the deploy job can reach with brokered credentials | `deploy/` |

GitHub doesn't swap out. Bootstrap, the gate and the agent identity all depend on GitHub rulesets, Apps, Actions and OIDC.

Whatever you replace, keep the property the design depends on: the agent cannot change the control.

## Related work

"Software factory" is the name in use for systems where agents build software from specs and issues, and people set direction and approve risk. These projects work in the same space. Descriptions are from their own sites and repos, November 2026.

| Project | What it is | License |
| --- | --- | --- |
| [Warp Oz and Warp Factories](https://docs.warp.dev/factories/) | Warp's platform for cloud agents. A factory combines agent roles, work sources and automation stages around shared repos. Runs Claude Code, Codex or Warp's own agent | Commercial |
| [StrongDM Attractor](https://github.com/strongdm/attractor) | Natural-language specs for a non-interactive coding agent for use in a software factory, written for you to build your own implementation | Apache-2.0 |
| [OpenHands](https://github.com/OpenHands/OpenHands) | A self-hosted control center for coding agents and automations, with optional Docker sandboxes per conversation | MIT |
| [Factory](https://factory.com/) | An agent-native development platform. Its agents ("Droids") work from the CLI, desktop, web, Slack, issue trackers and CI | Commercial |
| [Ona](https://ona.com/) (formerly Gitpod) | Development environments, agents and guardrails, with runners in your own cloud | Commercial |

This repo builds the trust boundary around the agent: its identity, credentials, the merge gate and egress, from GitHub, Cloudflare and AWS primitives. The agent itself is an existing headless CLI such as Claude Code or Codex. A comparison with these projects is in progress.

## Read first

- [Spec 0001: secure build-agent workflow](docs/specs/0001-secure-build-agent-workflow.md)
- [Sandbox bake-off](docs/research/sandbox-bakeoff.md)
- Decisions: [ADR-001](docs/adr/ADR-001-agent-github-app-identity.md) · [ADR-002](docs/adr/ADR-002-oidc-credential-broker.md) · [ADR-003](docs/adr/ADR-003-tier-check-reusable-workflow.md) · [ADR-004](docs/adr/ADR-004-cloudflare-sandbox.md)
