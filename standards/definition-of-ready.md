# Definition of ready

An issue is ready when a build agent can finish it in one run without asking anything, and the operator can review the PR in about ten minutes. The planning agent applies these checks when it writes a plan and when it grooms the backlog (`/groom`). `/dispatch` checks the mechanical ones again before labeling. The PR audit's readiness review runs them on plan PRs with a second model (spec 0001, Backlog and readiness).

Checking early is the point. A problem found at dispatch costs a plan PR; a problem found by the build agent costs a blocked run and a round trip with the operator.

## Mechanical checks

`/dispatch` and the readiness review both run these.

- [ ] Exactly one `area:*` label.
- [ ] Exactly one `run:*` profile label (ADR-007).
- [ ] Every "blocked by" link points to an issue in this wave or one already closed as `completed`. None closed as `not_planned`.
- [ ] An **Acceptance** section with at least one command that runs in the sandbox: no secrets, and no network beyond the package registries.
- [ ] An expected tier with the paths that set it.
- [ ] A **Data change** line: `none`, or the step and direction (`standards/data-change-patterns.md`).
- [ ] A plan reference (`Plan: docs/plans/<slug>.md, <key>`).

## Judgment checks

The planning agent answers each one. The readiness reviewer challenges them.

- **One decision away from done?** If the agent would have to choose between two designs, the issue isn't ready. Make the choice in the issue, or write an ADR first.
- **Is "done" observable?** Each acceptance result can be checked by a command or by looking at staging. "Works correctly" is not a result.
- **Does it fit one run?** One touch area, one PR, about ten minutes to review. If the task list has more than six or seven items, split it.
- **Are the references enough?** The agent reads only the issue, its references and the repo's instructions. Anything the operator knows but hasn't written down is missing.
- **Is the profile right?** Compare it with the default table in `wave-planning.md`. A foundation issue on `small` is a likely escalation.
- **Is the data change safe to roll back?** Two-way unless the plan says otherwise and puts the issue after a release (ADR-008).
- **What would the agent most likely get wrong?** If there's an obvious wrong turn, name it in Background.

## Bugs

A bug issue is ready when, in addition to the checks above, it has:

- [ ] Steps to reproduce, or the failing test or log line.
- [ ] Expected and actual behavior.
- [ ] Where it was seen: preview, staging or production, and the build id from `/health`.
- [ ] A failing test as the first task, so the fix is proven.

A production bug that is hurting users is an incident, not backlog. Roll back first (ADR-008); the bug issue comes after.
