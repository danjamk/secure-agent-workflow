# secure-agent-workflow

Tooling and standards for letting coding agents build with little supervision, while nothing reaches production unchecked.

The agent can't change the controls: they live in the sandbox, GitHub permissions and cloud credentials, not in instructions or settings files the agent can read and edit.

**Status:** design. The spec and decisions are written; nothing is built yet.

## How it works

1. A human writes the spec, plan and ADRs, and turns the plan into issues.
2. Labeling an issue `agent:ready` starts a build agent in a fresh, locked-down sandbox.
3. The agent works on its own branch and opens a PR. It can't touch workflows, settings or `main`.
4. A merge gate routes the PR by what it touches. Low-risk changes merge on green checks; risky ones wait for a human.
5. Only `main` can deploy, and only the production deploy job can get production credentials.

## Pieces

| Folder | What it will hold |
| --- | --- |
| `bootstrap/` | One command that applies rulesets, environments and gate wiring to a repo |
| `orchestrator/` | Cloudflare Worker that runs agents in sandboxes, with credentials kept outside |
| `gate/` | Reusable merge-gate workflows: checks, scanners, tier check, PR audit |
| `deploy/` | Deploy template with a GitHub OIDC credential broker |
| `standards/` | ADR template, agent instructions, issue template, tier map |
| `redteam/` | Attacks the controls must stop |

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
| Credential broker | GitHub OIDC to AWS IAM and Parameter Store ([ADR-002](docs/adr/ADR-002-oidc-credential-broker.md)) | Vault or OpenBao; GCP Workload Identity with Secret Manager; Azure federated credentials with Key Vault; GitHub environment secrets, which is simplest but long-lived | `deploy/` |
| Deploy target | Cloudflare Workers | Any target the deploy job can reach with brokered credentials | `deploy/` |

GitHub doesn't swap out. Bootstrap, the gate and the agent identity all depend on GitHub rulesets, Apps, Actions and OIDC.

Whatever you replace, keep the property the design depends on: the agent cannot change the control.

## Read first

- [Spec 0001: secure build-agent workflow](docs/specs/0001-secure-build-agent-workflow.md)
- [Sandbox bake-off](docs/research/sandbox-bakeoff.md)
- Decisions: [ADR-001](docs/adr/ADR-001-agent-github-app-identity.md) · [ADR-002](docs/adr/ADR-002-oidc-credential-broker.md) · [ADR-003](docs/adr/ADR-003-tier-check-reusable-workflow.md) · [ADR-004](docs/adr/ADR-004-cloudflare-sandbox.md)
