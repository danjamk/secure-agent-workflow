# Plan: Workflow loop

Status: Draft · Date: 2026-11-01 · Spec: [0001](../specs/0001-secure-build-agent-workflow.md) (Backlog and readiness, Run profiles, Run metrics, Retrospectives, Releases) · ADRs: [007](../adr/ADR-007-model-and-effort-routing.md), [008](../adr/ADR-008-rollback-first-and-data-compatibility.md)

## Summary

The PR that carries this plan lands the parts that are only standards: the definition of ready, data change patterns, retro and release templates, the run notes section, and the `/groom`, `/retro` and `/release-prep` skills. They work as soon as it merges.

This plan covers the parts that need code. Each wave extends work that's already planned, so it rides along with that build order step instead of adding a new one.

| Wave | Goal | Issues | Tier 2 or 3 PRs | Runs | Recommended cap | Profiles |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | Run profiles and run metrics in the orchestrator (build order step 1) | 4 | 4 | One at a time | 1 | 1 small-medium, 1 standard-medium, 1 frontier-high, 1 standard-high |
| 2 | Readiness review, data-change check and reviewer profiles in the PR audit (step 2) | 3 | 3 | One at a time | 1 | 2 standard-high, 1 standard-medium |
| 3 | Rollback target, smoke tests and rollback rehearsal (step 3) | 2 | 2 | One at a time | 1 | 1 standard-high, 1 frontier-high |

Every PR in this plan is tier 2: `orchestrator/`, `bootstrap/`, `gate/` and `deploy/` match no tier 1 pattern. That's intended for control code. Wave 1 has four tier 2 PRs, one over the guideline in `wave-planning.md`; none of them can become tier 1, and W1-1 is a two-minute review.

## Changes to existing issues

After this plan merges, the planning agent adds a "See also" line to each of these, pointing at this plan. No scope moves out of them.

- #9 (run the agent CLI in a sandbox): the CLI and model come from the run profile (W1-3).
- #13 (coordinator): snapshot the `run:*` label at dispatch (W1-2).
- #21 (PR audit): readiness review, data-change check and reviewer profiles (Wave 2).
- #33 (release PRs): the release PR opens with `standards/release-template.md` as its body, for `/release-prep` to fill in.
- #34 (production deploy): records the rollback target and runs smoke tests (W3-1).

## Wave 1: Run profiles and run metrics

Milestone: `Wave 1: Run profiles and run metrics`

**Operator tasks before dispatch:**

1. Update the `planning` environment's setup script from `docs/guides/planning-agent.md`, so cloud sessions get `/groom`, `/retro` and `/release-prep`.
2. Add `.github/ISSUE_TEMPLATE/bug.yml` with the bug fields from `standards/definition-of-ready.md` (tier 3, so human-authored).

**Runs:** one at a time, because W1-2 to W1-4 share `area:orchestrator`, and W1-1 is small. Recommended cap: 1.

**Done when:** an issue labeled `run:small-low` and dispatched runs on the model `RUN_PROFILES` maps `small` to, and its PR links a run record showing profile, tokens and cost.

**Data changes:** W1-4 adds run records to Durable Object storage: `expand`, two-way.

### W1-1: Create the run profile labels in bootstrap

- **Area:** `area:bootstrap`
- **Expected tier:** 2, because it changes `bootstrap/`
- **Run profile:** `small-medium`, because it's a list of labels in an existing pattern
- **Data change:** none
- **Blocked by:** nothing

**Background.** ADR-007 puts a `run:<class>-<effort>` label on every issue. Bootstrap already creates the `agent:*` labels; the nine profile labels belong with them.

**Tasks**

- [ ] Add `run:small-low` through `run:frontier-high` (nine labels) to the labels bootstrap creates, with one description each.
- [ ] Include them in the read-back verification and the dry-run output.
- [ ] Tests for the label list.

**Acceptance**

```bash
make check
```

- A dry run against a repo with no `run:*` labels lists all nine as to be created; a second dry run after applying lists none.

**References:** ADR-007, `bootstrap/README.md`

### W1-2: Snapshot the run profile at dispatch

- **Area:** `area:orchestrator`
- **Expected tier:** 2, because it changes `orchestrator/`
- **Run profile:** `standard-medium`, because it extends the snapshot ADR-005 already takes
- **Data change:** none beyond the queue entry #13 defines
- **Blocked by:** #13

**Background.** The coordinator snapshots an issue's blockers and area when the operator adds `agent:ready` (ADR-005). The run profile must be snapshotted the same way, so an agent editing its label later changes nothing (ADR-007).

**Tasks**

- [ ] Read the issue's `run:*` label when it enters the queue, and store it on the queue entry.
- [ ] No label, or more than one: use `standard-medium` and report it in the digest.
- [ ] Ignore later changes to `run:*` labels until re-dispatch.
- [ ] Tests for: one label, none, two, and a label changed after entry.

**Acceptance**

```bash
make check
```

- A queue entry created from an issue labeled `run:frontier-high` keeps `frontier-high` after the label is changed to `run:small-low`.

**References:** ADR-005 (Entering the queue), ADR-007

### W1-3: Map run profiles to models and budgets, with one escalation

- **Area:** `area:orchestrator`
- **Expected tier:** 2, because it changes `orchestrator/` and `wrangler.*`
- **Run profile:** `frontier-high`, because it sets budgets that are cost controls
- **Data change:** none
- **Blocked by:** W1-2, #9, #11

**Background.** The orchestrator turns a profile into a concrete agent CLI, model, effort setting, token budget and wall-clock limit from `RUN_PROFILES`, a Worker variable the operator sets (ADR-007). A failed run gets one retry at the next class up.

**Tasks**

- [ ] Parse and validate `RUN_PROFILES` at startup. An invalid map fails closed: no runs start, and the digest says why.
- [ ] Start each run with its profile's CLI, model and effort, and pass its token budget to the outbound handler and its wall-clock limit to the run.
- [ ] On a run that ends failed, or hits its token budget with acceptance failing: if `AUTO_ESCALATE` is on and the daily budget allows, restart once at the next class up from the branch and handoff note. Otherwise handle it as blocked. `frontier` never escalates.
- [ ] Record the escalation on the run and in the PR comment.
- [ ] Tests for the mapping, an invalid map, escalation, no second escalation, and escalation refused by the daily budget.

**Acceptance**

```bash
make check
```

- A failing `small-medium` run is restarted once as `standard-medium`; a second failure marks the issue `agent:blocked` with the reason.

**References:** ADR-007, ADR-005 (Daily spend budget), spec 0001 (Cost controls)

### W1-4: Record run metrics and a per-wave report

- **Area:** `area:orchestrator`
- **Expected tier:** 2, because it changes `orchestrator/`
- **Run profile:** `standard-high`, because the per-wave rollup needs care with resumes and escalations
- **Data change:** `expand`, two-way: new run records in Durable Object storage, versioned (`"v": 1`)
- **Blocked by:** W1-3, #10

**Background.** `/retro` and the profile table need per-run cost and outcome data (spec 0001, Run metrics). The orchestrator already sees every run's tokens and outcome.

**Tasks**

- [ ] Store a run record: issue, milestone, profile, model, tokens, cost, wall-clock, outcome, resumes, escalations, catch-ups.
- [ ] Link the record from the PR (the run comment that #10's log link uses).
- [ ] Serve a per-milestone report as JSON, behind the same access as the logs: cost per merged PR including rework, first-pass rate per profile, blocked runs, escalations, catch-ups.
- [ ] Tests for the rollup with a resumed run, an escalated run and a catch-up run.

**Acceptance**

```bash
make check
```

- The report for a milestone with one clean run and one escalated run shows a first-pass rate of 50% and counts both runs' cost against the escalated issue's merged PR.

**References:** spec 0001 (Run metrics, Retrospectives), ADR-007, `standards/skills/retro/SKILL.md`

## Wave 2: PR audit additions

Milestone: `Wave 2: PR audit additions`

**Operator tasks before dispatch:** add the readiness review job to this repo's gate caller for PRs that change `docs/plans/**` (tier 3).

**Runs:** one at a time, because all three are `area:gate`. Recommended cap: 1.

**Done when:** a plan PR with an issue missing its acceptance section fails the readiness check with that issue named, and an agent PR that drops a column under an `expand` issue fails the data-change check.

**Data changes:** none.

### W2-1: Add the readiness review for plan PRs

- **Area:** `area:gate`
- **Expected tier:** 2, because it changes `gate/`
- **Run profile:** `standard-high`, because the reviewer prompt is the product
- **Data change:** none
- **Blocked by:** #21

**Background.** Readiness is checked by the planning agent; a reviewer from a different model family catches what it misses (spec 0001, Backlog and readiness). It reports through a check, never a review.

**Tasks**

- [ ] For PRs that change `docs/plans/**`, run a reviewer from a different model family than the planning agent over each issue in the plan.
- [ ] Mechanical checks from `standards/definition-of-ready.md` run as code, not by the model. Judgment checks go to the reviewer, which reports the likely wrong turn and any missing decision per issue.
- [ ] Fail the check on any mechanical failure; report judgment findings in the summary comment without failing.
- [ ] Tests for the mechanical checks, and a fixture plan with known gaps.

**Acceptance**

```bash
python3 -m unittest discover -s gate
```

- The fixture plan's issue with no `run:*` profile and no acceptance commands fails the check by key.

**References:** `standards/definition-of-ready.md`, spec 0001 (Backlog and readiness, PR audit)

### W2-2: Check declared data changes against the diff

- **Area:** `area:gate`
- **Expected tier:** 2, because it changes `gate/`
- **Run profile:** `standard-high`, because it must tell expand from contract in real migrations
- **Data change:** none
- **Blocked by:** W2-1

**Background.** ADR-008 depends on each issue's **Data change** line being true. The spec-conformance reviewer compares it with the diff.

**Tasks**

- [ ] Read the linked issue's **Data change** line.
- [ ] Flag as code: a migration file in a PR whose issue says `none`; a `DROP`, `RENAME` or column type change, or a deleted or renamed Durable Object class, in a PR that isn't `contract`.
- [ ] Ask the reviewer about stored-shape changes the patterns can't catch (KV values, JSON columns, message formats).
- [ ] Tests with fixture diffs for each case.

**Acceptance**

```bash
python3 -m unittest discover -s gate
```

- A fixture diff with `ALTER TABLE ... DROP COLUMN` under an `expand, two-way` issue fails the check.

**References:** ADR-008, `standards/data-change-patterns.md`

### W2-3: Set the reviewer's profile by tier

- **Area:** `area:gate`
- **Expected tier:** 2, because it changes `gate/`
- **Run profile:** `standard-medium`, because it's configuration on existing reviewer calls
- **Data change:** none
- **Blocked by:** W2-2

**Background.** ADR-007: tier 1 PRs get a `standard-low` reviewer, tier 2 and 3 and release PRs get `frontier-high`. The security reviewer is always a different family than the builder.

**Tasks**

- [ ] Choose the reviewer profile from the tier check's result.
- [ ] Take the builder's family from the run record and pick the security reviewer from another family.
- [ ] Record the reviewer's profile and cost in the summary comment.
- [ ] Tests for each tier and for the family rule.

**Acceptance**

```bash
python3 -m unittest discover -s gate
```

- A tier 1 PR built by one family gets a `standard-low` reviewer from another family.

**References:** ADR-007, spec 0001 (PR audit)

## Wave 3: Release safety

Milestone: `Wave 3: Release safety`

**Operator tasks before dispatch:** add the rollback workflow caller for the `staging` and `production` environments (tier 3), once W3-2's script exists.

**Runs:** one at a time, because both are `area:deploy`. Recommended cap: 1.

**Done when:** a staging deploy records the version it replaced, and the rehearsal rolls staging back to it and forward again, with `/health` checked after each step.

**Data changes:** none.

### W3-1: Record the rollback target and run smoke tests after deploy

- **Area:** `area:deploy`
- **Expected tier:** 2, because it changes `deploy/`
- **Run profile:** `standard-high`, because it touches the deploy path
- **Data change:** none
- **Blocked by:** #34

**Background.** A rollback restores the version the deploy replaced (ADR-008), so the deploy must record it. The smoke tests are the automatic half of a release's verification plan.

**Tasks**

- [ ] Before deploying, read the currently deployed Worker version id and record it as the rollback target: in the deployment's GitHub environment record, and in the release PR comment.
- [ ] After deploying, run the consumer's smoke test command (named in its config; skip with a warning if absent) after the `/health` check.
- [ ] Fail the deploy job if either fails, and say whether rollback is safe (from the release PR's direction line).
- [ ] Do the same for staging deploys.
- [ ] Tests for recording the target and for the failure paths.

**Acceptance**

```bash
make check
```

- A staging deploy whose smoke test fails reports the failure and the recorded rollback target.

**References:** ADR-008, spec 0001 (Releases), [Cloudflare Workers rollbacks](https://developers.cloudflare.com/workers/configuration/versions-and-deployments/rollbacks/)

### W3-2: Add the rollback script and a staging rehearsal

- **Area:** `area:deploy`
- **Expected tier:** 2, because it changes `deploy/`
- **Run profile:** `frontier-high`, because a broken rollback is found during an incident
- **Data change:** none
- **Blocked by:** W3-1

**Background.** Rollback is one workflow run (spec 0001, developer experience). This issue writes the script the workflow calls. The workflow file itself is tier 3, an operator task.

**Tasks**

- [ ] `deploy/rollback.sh <environment>`: read the recorded target, refuse if the release in place is marked one-way, run `wrangler rollback` to the target, and check `/health` reports the previous build id.
- [ ] Dry-run mode that prints what it would do.
- [ ] A rehearsal mode for staging: roll back, check, roll forward to the version it started from, check.
- [ ] Document both in `deploy/README.md`, including that a rollback doesn't revert D1 or Durable Object migrations.
- [ ] Tests with a stubbed `wrangler`.

**Acceptance**

```bash
make check
```

- With a one-way release recorded, `rollback.sh production` refuses and prints the forward-fix instruction.

**References:** ADR-008, `standards/release-template.md`
