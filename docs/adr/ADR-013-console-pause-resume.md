# ADR-013: The console can pause and resume a source, and show several sources at once

Status: Proposed · Date: 2026-11-25 · Amends: spec 0002 (hard constraints 1 to 3), [ADR-012](ADR-012-console-feeds.md) (snapshot feed is read-only)

## Context

Spec 0002 gives the console one write, per-run Stop (ADR-010). ADR-012 adds a snapshot feed for local hosts, read-only, one feed per source. Operating a local host showed two gaps:

- **Pausing a whole source.** The common intervention isn't killing one run. It's "start nothing new" for a while, letting running work finish: before changing the host, while a cost question is open, or when something looks wrong. Today that takes a shell on the host and a kill switch file. Nothing records who paused or why, and a pause set by hand has stopped work for 20 minutes without anyone noticing.
- **More than one source.** A local host can run several sources: one dispatcher per account, or a dispatcher next to ADR-011's `local` host. The operator wants them on one screen, each with its own spend limit, slots and state.

The local host's side of this, an aggregator and a request inbox, is decided in the host's own records. This ADR covers the console and the route contract, which every feed shares.

## Decision

**Pause and resume are queue actions, per source.** Pause means nothing new starts; running work finishes. Resume clears the pause. Neither stops, restarts or kills anything. Per-run Stop stays as ADR-010 defines it.

**Routes**, on any feed that offers them:

```
POST api/pause    body { source?: string; reason: string }   Content-Type: application/json
POST api/resume   body { source?: string; reason: string }
→ 202 { requestId: string; state: "pausing" | "resuming" }
```

- `source` is required on a combined feed and ignored on a single-source feed.
- The operator's identity comes from the feed's front door, as for Stop (spec 0002, constraint 6): the Access JWT on the orchestrator feed, the tailnet login on a local host. The feed's backend checks it against its own operator list.
- The backend applies the request, records who and why, and reflects it in `factory.pause` (with `by`).
- Repeating a request that's already in effect returns 202 and changes nothing.

**Contract fields** (route contract in `docs/plans/console-phase-1.md`):

- Every response gains top-level `source: string | null` and `host: string | null`. They're `null` on a single orchestrator feed.
- On a combined feed, each waiting item and run row carries `source`.
- `factory.pause.by: string | null`: who paused, for `reason: "operator"`.
- `factory.controls: { pause: boolean; resume: boolean }`: whether the routes exist. It's separate from `stopAvailable`, which means per-run Stop.
- `factory.sources`: per-source summaries on a combined feed, else `null`. Spend, slots and pause stay per source; a combined feed never sums limits or slots across sources.

**Console behavior:**

- Pause and Resume are press-and-hold, like Stop. They are never in a menu, and they're shown only when `controls` says so.
- Resume first shows the current pause: reason, who set it and since when. A pause someone set for a reason shouldn't be cleared blind.
- The sequence is pausing or resuming (request accepted), then paused by `<by>` or resumed (seen in `factory.pause`). A rejected request shows why.
- On a combined feed, each source has its own panel and its own feed-lost state (constraint 7, per source). A stale source doesn't make the others look stale. Cross-source figures name the source they leave out.

**Spec 0002 changes:**

- Hard constraint 1 adds "pause or resume a source".
- Constraint 2 allows Pause and Resume on mobile, because the phone is where the operator is when they need them.
- Constraint 3: Phase 1 is read-only plus Stop, Pause and Resume, where the feed offers them.

**The orchestrator feed sets `controls` to false** until the orchestrator has a pause it can apply (the coordinator already pauses for spend; an operator pause is a separate human-authored issue). The snapshot feed sets it true where the host runs the aggregator.

## Alternatives considered

- **Pause by stopping every running run.** No new action. It lost because it throws away work in progress, and the operator usually wants running work to finish.
- **Pause with a label or a shell command only.** Nothing to build. It lost because the operator is usually on a phone, and a hand-set pause records no reason or identity. Unannounced pauses are what started this.
- **Reuse `stopAvailable` for pause.** One fewer field. It lost because Stop is per run and pause is per source. A feed can offer one without the other.
- **One combined panel with summed spend and slots.** Simpler screens. It lost because each source has its own limit and slots, so a sum hides which source is near its limit.

## Consequences

- The console has three writes: Stop, Pause and Resume. Each reaches the backend through the same front door and holds no credential (spec 0001).
- **Wave 1 gains W1-9 (pause and resume controls, combined-feed panels).** It builds against fixtures.
- **The design needs new screens.** There's no Pause or Resume control and no per-source panel in `console/design/`, and wave issues can't edit the design. W1-9 waits for Claude Design to add them.
- An orchestrator operator pause is follow-up work, human-authored (tier 3 `orchestrator/**`). Until then the orchestrator feed sets `controls` false and the UI hides the controls.
- A local host's backend must apply requests without restarting its dispatcher, and must log each one. The host's own ADR covers how.
