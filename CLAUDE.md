# secure-agent-workflow

Tooling and standards for letting coding agents build with little supervision,
while nothing reaches production unchecked.

## Stack

`bootstrap/` and `gate/` are built, and `deploy/` has the AWS broker and the credential tool; the rest is designed but not built. Stack:

| Component | Stack | Decision |
|---|---|---|
| `orchestrator/` | Cloudflare Worker + Sandbox SDK, TypeScript, pnpm, vitest, wrangler | ADR-004 |
| `gate/` | GitHub reusable workflows, consumed pinned by SHA | ADR-003 |
| `deploy/` | GitHub OIDC credential broker (preview, staging and prod roles, CloudFormation), Cloudflare target, OpenTofu for project infrastructure, credentials declared per repo and checked before storing | ADR-002, ADR-006, ADR-007 |
| `bootstrap/` | `gh api` shell scripts, idempotent, dry-run mode | Spec 0001 |

Two things a newcomer gets wrong:

- **A control the agent can edit is not a control.** Controls live in the sandbox,
  GitHub permissions and cloud credentials. Never implement one as agent
  instructions or as a settings file inside the sandbox.
- **The agent's GitHub App has no `workflows` and no `administration` permission**
  (ADR-001). Anything that needs either belongs in `bootstrap/`, run by a human.

## Layout

| Path | Contents |
|---|---|
| `docs/specs/` | Numbered specs. `0001` is the system spec. |
| `docs/adr/` | `ADR-NNN-*.md` decision records |
| `docs/research/` | Research the ADRs cite |
| `docs/guides/` | Operator guides, such as setting up the planning agent |
| `docs/index.html` | The overview page, published with GitHub Pages |
| `bootstrap/` | `bootstrap.sh`: applies repo controls to one repo, idempotent, verified by read-back |
| `bootstrap/github-app/` | Agent GitHub App manifest, creation and token scripts, verification |
| `gate/` | Merge gate scripts and tests. `python3 -m unittest discover -s gate` |
| `.github/workflows/` | The reusable gate workflows consumers call, pinned by SHA |
| `standards/tier-map.yml` | Default tier map; consumers get a copy from bootstrap |
| `standards/planning-agent.md` | Planning agent instructions; the cloud environment's setup script fetches them |
| `standards/` (other files) | Build agent instructions, issue, ADR and wave plan templates, wave planning rules, and the operator's `/dispatch` skill. `standards/README.md` says who uses each and how it reaches them |
| `deploy/broker/aws/` | Broker CloudFormation templates and `broker.sh` (run by a human with `AWS_PROFILE`), plus testbed workflows that check every role's allows and denies |
| `deploy/credentials/` | `credentials.py` (`broker.sh set` and `status`), one checker per system in `checks/`, and the example `infra/credentials.yml`. Tests: `python3 -m unittest discover -s deploy/credentials` |

`orchestrator/` and `redteam/` do not exist yet.

## Conventions

- **This repo is public.** Refer to consumers by role ("the reference build"),
  never by company or client name.
- **Each component folder is replaceable** (spec 0001, goal 7). Its `README.md`
  states what it expects from the other components and what a fork could use
  instead. Don't reach across folders for internals; go through that contract.
- **Build order:** build agent through staging, then PR audit, then production
  releases, then planning agent identity. Don't make earlier steps wait on later ones.
- **Environments:** `agent/*` and feature branches deploy previews and `main`
  deploys staging, both to the dev target. Production deploys to the prod target,
  only from the `production` branch through a release PR (spec 0001, Branches and
  environments).
- **Account terms.** Use these names, not "tooling account" or "dev account":

  | Term | What it is | Holds |
  | --- | --- | --- |
  | Factory account | The platform's own cloud account. Never a deploy target | Orchestrator, sandboxes, operator console |
  | Dev target | Where the app deploys previews and staging. One account per provider the app uses, such as a Cloudflare account, an Auth0 tenant or a database project | Preview and staging deploys |
  | Prod target | Where the app deploys production, again one account per provider | Production deploys |
  | Broker account | The key store. Its dev and prod stores can share one AWS account or use two | OIDC roles, Parameter Store, OpenTofu state |

## Versioning

**secure-agent-workflow is in build mode** — `0.1.x`, patch bumped on every merged
PR, no CHANGELOG and no tags. The build id in `/health` is `<version>+<shortsha>`.
No `package.json` exists yet; the version starts at `0.1.0` when the orchestrator
lands. Cap the phase and move to release mode when `bootstrap/` and `gate/` protect
a repo other than this one and red-team results are published.
