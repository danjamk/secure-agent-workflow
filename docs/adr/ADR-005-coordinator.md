# ADR-005: One Durable Object coordinates runs, with GitHub as the source of truth

Status: Proposed · Date: 2026-10-31

## Context

Released issues can't all start a sandbox at once. Some depend on others, two issues in the same part of the codebase make conflicting PRs, and spend needs a ceiling across runs (spec 0001, Coordination and parallelism, Cost controls). Dispatching a whole wave in one command is only safe if something holds each issue until it can run. Issue #13 builds that coordinator; this ADR fixes its design.

Two constraints shape it. The coordinator must hold no state the agent can change, because the agent App has `issues: write` and can edit labels and links on any issue. And it must survive missed webhooks, because GitHub doesn't redeliver them on its own.

## Decision

One coordinator Durable Object per orchestrator deployment holds the queue, the run slots and the touch-area locks. GitHub stays the source of truth: the coordinator acts on webhooks and also reconciles against GitHub on an alarm every 5 minutes, so a missed webhook delays a run but never loses one.

**Entering the queue**

- An issue enters when `agent:ready` is added and the webhook's `sender` is Dan's login. A label added by anyone else is ignored and reported in the digest.
- At entry the coordinator snapshots the issue's "blocked by" links and its `area:*` label. Later edits to those are ignored until Dan re-dispatches (removes and re-adds `agent:ready`). A running agent therefore can't unblock other issues or move them out of its area.
- Removing `agent:ready` or adding `agent:stop` takes the issue out of the queue, or stops its run (spec 0001, Stop).

**Starting a run.** On every webhook and alarm, the coordinator walks the queue in order of entry and starts each issue that passes all four checks:

1. A run slot is free. Slots in use are below the concurrency cap.
2. Every issue in its dependency snapshot is closed as `completed`. A blocker closed as `not_planned` keeps the issue waiting and is flagged in the digest for Dan.
3. No other issue holds its touch-area lock.
4. The queue isn't paused for spend.

An issue that fails a check is skipped, not a barrier: later issues can still start. Resumed runs (after `agent:blocked` clears) and catch-up runs go ahead of new issues.

**Slots and locks are held for different spans**

| Held | From | Until |
| --- | --- | --- |
| Run slot | Sandbox start | Sandbox teardown: done, blocked, failed or stopped |
| Touch-area lock | Sandbox start | The issue's PR merges or closes, or the issue is stopped |

A blocked issue frees its slot but keeps its area, so no sandbox idles while it waits for Dan and no second issue starts conflicting work in the same area. An issue with no `area:*` label locks every area and runs alone. An issue with several labels locks all of them.

**Concurrency cap.** One global cap across every repo the orchestrator serves, default 1. Dan sets it as a Worker variable (`MAX_CONCURRENT_RUNS`) with `wrangler`. The agent holds no Cloudflare credential, so it can't change it, and the coordinator never raises it. The plan recommends a cap per wave, and Dan applies it when dispatching.

**Catch-up runs.** On each push to `main`, the coordinator checks the open agent PRs. One whose `mergeable_state` is `dirty` gets a catch-up run on its branch that merges `main` into it. This is merge, not rebase: a rebase needs a force-push, which the push filter rejects, and squash merge keeps `main` linear anyway. A PR gets at most one catch-up per `main` commit. After two catch-ups that leave it still conflicting, it's marked `agent:blocked` with the reason.

**Daily spend budget.** The outbound handler reports each run's model spend to the coordinator, which totals it per UTC day. When the total reaches the budget (`DAILY_SPEND_LIMIT_USD`, set like the cap), the queue pauses: running runs finish within their own per-run budgets, and no new run starts. The coordinator posts once to Slack and resumes at the next UTC day, or sooner if Dan raises the limit. The worst-case overshoot is the cap times the per-run token budget.

**Digest.** The coordinator gives the daily digest every queued, running, blocked and waiting issue. A waiting issue shows the reason it's held: blocker, area lock, slot, spend pause or ignored label.

## Alternatives considered

- **Cloudflare Queues.** Retries and delivery come with it, but a queue consumer can't hold an area lock or skip an item and keep it. Gating needs strongly consistent shared state, which a Durable Object gives in one place.
- **State in GitHub labels only** (for example `agent:queued` and `agent:running`). It's visible in GitHub, but the agent App can write labels, so the agent could edit its own scheduling state. Labels also can't serialize two webhooks that race for the last slot.
- **A coordinator per repo.** It isolates repos, but spend and sandbox cost are account-wide, so the cap and the budget would need a second global layer anyway. One coordinator is simpler while v1 serves a few repos.
- **Release the area lock at sandbox teardown.** This gives more parallelism, but a blocked or tier 2 PR would leave its area open to a second, conflicting PR. Catch-up runs would then turn conflicts the plan meant to prevent into routine work.
- **Rebase for catch-up runs**, as spec 0001 first said. Rejected: it needs a force-push, which the push filter rejects.

## Consequences

- Dispatching a whole wave at once is safe: order comes from the dependency snapshot and the area locks, not from when labels were added.
- A tier 2 PR waiting on Dan holds its area. A wave with many tier 2 PRs in one area runs serially. That's another reason the planning standard puts tier 2 work in foundation issues.
- Re-dispatching is the only way to change an issue's dependencies or area after release. The `/dispatch` skill should handle a re-dispatch.
- The orchestrator needs Dan's GitHub login and two settings (`MAX_CONCURRENT_RUNS`, `DAILY_SPEND_LIMIT_USD`). The backstop outside this system is still the provider spend limits and Cloudflare billing alerts.
- Spec 0001's coordinator rule changes from rebase to merge for catch-up runs. This PR updates the spec to match.
