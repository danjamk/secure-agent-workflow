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
| `gate/` | Reusable merge-gate workflows: checks, scanners, tier check, AI reviewers |
| `deploy/` | Deploy template with a GitHub OIDC credential broker |
| `standards/` | ADR template, agent instructions, issue template, tier map |
| `redteam/` | Attacks the controls must stop |

## Read first

- [Spec 0001: secure build-agent workflow](docs/specs/0001-secure-build-agent-workflow.md)
- [Sandbox bake-off](docs/research/sandbox-bakeoff.md)
- Decisions: [ADR-001](docs/adr/ADR-001-agent-github-app-identity.md) · [ADR-002](docs/adr/ADR-002-oidc-credential-broker.md) · [ADR-003](docs/adr/ADR-003-tier-check-reusable-workflow.md) · [ADR-004](docs/adr/ADR-004-cloudflare-sandbox.md)
