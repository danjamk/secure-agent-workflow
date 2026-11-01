# Wave planning rules

How to cut a plan into waves so agents can run with few interruptions and the operator approves few PRs (spec 0001, Work units). The planning agent follows these when it writes `docs/plans/<slug>.md` from `wave-plan-template.md`.

## A wave

- **A wave is one GitHub milestone**, named `Wave <n>: <goal>`. The operator dispatches it with `/dispatch` and reviews its tier 2 and 3 PRs in one sitting.
- **A wave ends somewhere checkable.** When its last PR merges, staging shows something the operator can look at or test.
- **Waves run in order.** The first issues of a wave are blocked by the last issues of the wave before it, when they really depend on them.

## Keeping approvals few

The operator's work per wave is the number of tier 2 and 3 PRs, not the number of issues.

1. **Front-load tier 2 work.** Put dependency changes, migrations, auth and permission code, and deploy config into one or two foundation issues at the start of the wave. Block the wave's other issues on them, so those stay tier 1.
2. **Count the approvals.** Give each issue its expected tier. Aim for three or fewer tier 2 or 3 PRs per wave. If a wave needs more, look for tier 2 work that can move into a foundation issue.
3. **Keep tier 3 out of waves.** `.github/`, `CODEOWNERS` and the tier map are human-authored. List those changes as operator tasks at the top of the wave instead.

## Sizing an issue

- One agent run and one PR the operator could review in about ten minutes.
- One touch area. If the tasks reach into a second area, split the issue.
- Acceptance commands that run in the sandbox: no secrets, and no network beyond the repo's package registries.

## Parallel work

- **Each issue has exactly one `area:<name>` label.** Two issues in the same area never run at the same time (ADR-005), so parallelism only happens across areas.
- **Mark only real dependencies as "blocked by".** A false dependency serializes the wave for nothing. When later issues need something from a foundation issue, have the foundation issue define the interface (types, stubs, a schema) so the rest can proceed against it.
- **Recommend a concurrency cap per wave**, with the reason. Start at 1 until the merge record shows the agents' PRs are reliable. The operator sets the cap; the plan only recommends it.

## Ready before it's planned

- **Every issue passes `definition-of-ready.md`** before the plan PR opens. The judgment checks matter most: an issue that leaves the agent one design decision to make will come back as a blocked run.
- **Name the likely wrong turn.** If there's an obvious mistake an agent would make, say so in Background.

## Choosing a run profile

Give each issue the smallest profile you expect to pass on the first run (ADR-007). A miss costs more than it saves: a failed run, an escalation, and often an approver send-back. When unsure between two, pick the larger.

| Profile | Use for |
| --- | --- |
| `small-low` | Docs, renames, mechanical edits, config values, dependency bumps with good tests |
| `small-medium` | Small, well-specified changes in one file with clear tests |
| `standard-medium` | The default: a tier 1 feature or bug fix with clear acceptance |
| `standard-high` | Tricky logic in one area: parsers, state machines, non-trivial queries |
| `frontier-medium` | Changes that span several modules in one area, or unfamiliar code |
| `frontier-high` | Foundation issues: interfaces others build on, auth and permissions, concurrency, migrations, security-sensitive code |

This table is a starting point. `/retro` proposes changes from the run metrics; change it only through a PR.

## Data changes

Design them first, then split them (`data-change-patterns.md`, ADR-008).

- **Every issue that touches persisted data declares its step** (`expand`, `migrate`, `switch`, `contract`) and direction in its **Data change** line.
- **Expand and migrate go in foundation issues**, since migrations are tier 2 anyway.
- **Contract goes in a later wave, after a release.** A wave that must contract in the same release is one-way; say so in the plan and get the operator's agreement before the plan merges.
- **Backfills are their own issue**, not a task inside a migration issue.
