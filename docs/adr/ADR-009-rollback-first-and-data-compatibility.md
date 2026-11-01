# ADR-009: Releases roll back first, so every data change stays compatible with the previous release

Status: Proposed · Date: 2026-11-01

## Context

Production releases are designed but not built (spec 0001, Releases; #33, #34). When a release goes wrong, there are two responses: roll back to the previous version, or ship a fix forward. With agents building and nobody watching every merge, rollback is the better default. It takes minutes, it needs no new code, and no new code means no new review.

Rollback only works if the previous version can still run against the data the new version left behind. That is decided at design and build time, not at release time:

- `wrangler rollback` restores Worker code. It does not undo D1 migrations, Durable Object migrations or other changes to bound resources. Cloudflare documents that a rollback can fail when one of those happened in between.
- During a gradual deployment, two Worker versions serve traffic against the same storage. The old version reads what the new one writes.
- A release made of many agent PRs can carry a destructive migration nobody flagged as one.

A rollback can also hurt users: data written through a new feature may not be visible in the old version. So rollback first is the default, not an absolute rule.

## Decision

**Rollback first.** When a production release fails verification or causes an incident, the default is to roll back to the previous release's version. A forward fix is chosen instead only when:

- the release is marked one-way (below), or
- the operator judges that rolling back hurts users more than the defect does, for example by hiding data they've written since the release.

A forward fix goes through `main` and an expedited release PR, with the same gate. There is no hotfix branch.

**Every release is compatible with the release before it (N-1).** The previous release's code must run correctly against the data the new release writes. That makes rollback and gradual deployment both safe.

- Schema and data changes use expand/contract, following `standards/data-change-patterns.md`. A release may add (expand). It may not remove or rename what the previous release still reads.
- The contract step ships in a later release than the code that stops using the old shape. The plan puts contract issues in a later wave, after a release.
- Backfills are separate jobs, idempotent and resumable, never inside a migration.

**One-way releases are flagged, never discovered.** A release is one-way if it contains a contract step, a Durable Object migration that deletes or renames a class, or any other change the N-1 code can't run against. A one-way release needs:

1. A restore point taken immediately before the migration (D1 Time Travel bookmark or an export), recorded in the release PR.
2. A forward-fix plan in the release PR instead of a rollback plan.
3. The operator's explicit acknowledgment in the release PR.

**The plan decides first.** Every issue that changes persisted data names its data-change step (expand, migrate, switch, contract) and whether it is two-way or one-way. The planning agent checks this when grooming and planning. The PR audit checks that the diff matches. `/release-prep` lists every data change in the release and marks the release two-way or one-way.

**The rollback target is recorded at deploy time.** The production deploy records the version it replaced as the rollback target. A rollback restores that version. It's rehearsed on staging once per release.

## Alternatives considered

- **Forward fix first.** It never hides user data, but every incident needs new code, an agent run and a review while production is broken. It also leaves no fast option when the fix is unclear.
- **Down migrations for every migration.** They look like a rollback for data, but they're rarely tested, they lose data written since the release, and D1 and Durable Objects don't run them as part of a code rollback anyway.
- **Restore from backup as the rollback.** Point-in-time restore undoes everything written since the release, users' work included. It stays as the last resort for one-way releases, not the default.
- **A hotfix branch off `production`.** It's faster for one fix, but it splits history, needs its own ruleset and gate path, and has to be merged back. Expedited release PRs from `main` keep one path.

## Consequences

- Schema changes take two releases to finish. That costs a release cycle and buys a rollback that always works.
- Plans get a data-change field per issue, and the planning standard gets a patterns guide.
- The PR audit gets one more check: the declared data-change step matches the diff.
- The production deploy (#34) records the rollback target, and a rollback workflow plus a staging rehearsal join build order step 3.
- An incident still needs the operator's judgment on user impact. This ADR sets the default and the information needed to make that call quickly.
