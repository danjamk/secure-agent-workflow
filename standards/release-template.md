# Release <version>

<!--
The body of the release PR from main into production (spec 0001, Releases).
/release-prep drafts it; the operator edits it and approves the PR. Every
section is required. "None" is an answer; an empty section is not.

Delete this comment.
-->

**Direction:** <Two-way: rollback is safe | One-way: <why>. Forward fix only>

**Recommendation:** <Ship | Ship after <x> | Hold, because <x>>

## What changed

<From the PR audit's batch summary: user-visible changes first, then internal ones. Each line links its PR.>

| Tier | PRs |
| --- | --- |
| 1 | <n> |
| 2 | <n>: <links> |

Dependency changes: <list or "None">
Infrastructure changes: <OpenTofu plan summary or "None">

## Data changes

| PR | Step | Direction | Notes |
| --- | --- | --- | --- |
| #<n> | `expand` | Two-way | <table.column added, nullable> |

<"None" if no PR changes persisted data. A `contract` step or a Durable Object class deletion makes the release one-way (ADR-009).>

## Risks

Highest first. A risk without a mitigation is a reason to hold.

| Risk | Likelihood | Impact | Mitigation |
| --- | --- | --- | --- |
| <what could go wrong> | <low/med/high> | <who notices, how badly> | <flag, test, staged rollout, watch signal> |

## Verification

**Before deploy:** <checks on staging: what to click, which smoke tests, which data to inspect>

**After deploy, automatic:** `/health` reports `<version>+<shortsha>`; smoke tests <list> pass.

**Watch window:** <how long>, watching <error rate, specific logs, a key user flow>. Rollback trigger: <the observable condition>.

## Rollback

**Target:** <the version id the deploy will record as previous; filled in by the deploy if not known yet>

**Steps:**

1. <Turn off flag X, if the problem is behind it.>
2. Run the rollback workflow to the target version.
3. <Revert infrastructure change Y with OpenTofu, or "No infrastructure change">.
4. Check `/health` reports the previous build id.

**User impact of rolling back:** <what users lose or stop seeing; "None" for most releases>

## One-way releases only

- **Restore point:** <D1 Time Travel bookmark or export, taken just before the migration>
- **Forward-fix plan:** <what we'd ship, and how fast>
- [ ] Operator acknowledges this release can't be rolled back.
