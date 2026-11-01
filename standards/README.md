# Standards

Templates and instructions that agents, reviewers and the operator rely on (spec 0001, Components). None of them is a control: an agent can read and ignore any of them. The controls live in the sandbox, GitHub permissions and cloud credentials. These files make the agents' work predictable and easy to review.

| File | Used by | How it reaches them |
| --- | --- | --- |
| `tier-map.yml` | The tier check | Bootstrap copies it into each repo once; the repo owns its copy. The tier check reads the copy at the PR's base commit, falling back to this file |
| `agent-instructions.md` | Build agents | The orchestrator puts it in the sandbox at the start of each run (#9) |
| `planning-agent.md` | The planning agent | The cloud environment's setup script fetches it from `main` (`docs/guides/planning-agent.md`) |
| `issue-template.md` | The planning agent, writing issues | Read from this repo; the planning agent reads it through its read-only connector |
| `adr-template.md` | The planning agent and the operator, writing ADRs | Same |
| `wave-planning.md`, `wave-plan-template.md` | The planning agent, writing plans | Same |
| `definition-of-ready.md` | The planning agent, `/groom`, `/dispatch` and the PR audit's readiness review | Same; the PR audit reads it from this repo |
| `data-change-patterns.md` | The planning agent designing data changes; build agents changing persisted data | Same; build agents get it in the sandbox with their instructions |
| `retro-template.md`, `release-template.md` | `/retro` and `/release-prep` | Same |
| `skills/dispatch/` | The operator, dispatching a wave | Linked once into `~/.claude/skills` on the operator's machine (below) |
| `skills/groom/`, `skills/retro/`, `skills/release-prep/` | The planning agent | The cloud environment's setup script fetches them into `~/.claude/skills` (`docs/guides/planning-agent.md`) |

## Installing `/dispatch`

`/dispatch` is an operator skill. It labels issues `agent:ready`, which starts build agents, so it runs on the operator's machine, never in an agent's session. Link it once and it works in every project:

```bash
ln -s /path/to/secure-agent-workflow/standards/skills/dispatch ~/.claude/skills/dispatch
```

Don't commit it into a consuming repo's `.claude/skills/`: cloud sessions load a repo's skills, and the planning agent shouldn't have a dispatch skill. Its `gh issue edit` call would fail there anyway, because cloud sessions block GraphQL.

## Contract

- **The issue template's shape is what the coordinator and the build agent expect.** "Blocked by" relationships and one `area:*` label feed the coordinator's queue (ADR-005). The acceptance commands are what the build agent runs before marking a PR ready.
- **The agent instructions name the labels, branch pattern and PR format** that the orchestrator, the outbound handler and the gate rely on: `agent/*` branches, `agent:blocked`, the tier line at the top of the PR, and the `## Run notes` section `/retro` reads.
- **The `run:<class>-<effort>` labels** are what the coordinator snapshots and the orchestrator maps to a model (ADR-008).
- **The issue's `Data change` line** is what the PR audit checks against the diff and `/release-prep` reads (ADR-009).
- Changing any of those names means changing those components too.

## Other options for a fork

| Option | Trade-off |
| --- | --- |
| Put agent instructions in each repo's `AGENTS.md` instead | Each repo can tune them, but they drift. The agent can also edit them in its own PR, so review them as tier 2 or 3 |
| GitHub issue forms (`.github/ISSUE_TEMPLATE/*.yml`) | Enforce fields when a human files an issue. They don't apply to issues created through the API, which is how the planning agent creates them |
