# Plan: Operator console, Phase 1

Status: Draft · Date: 2026-11-05 · Spec: [docs/specs/0002-operator-console.md](../specs/0002-operator-console.md)

## Summary

Build Phase 1 of the operator console: one read-only screen per device showing what's waiting on the operator, the last 24 hours of runs, and spend today, plus Stop on running rows. It is one wave of five console issues, after operator tasks that add the orchestrator routes the console reads from. Design: `console/design/` (screens in `console/design/screens/phase-1.md`).

| Wave | Goal | Issues | Tier 2 or 3 PRs | Runs | Recommended cap | Profiles |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | Phase 1 console | 5 | 0 expected | one at a time | 1 | 3 standard-medium, 2 standard-high |

## Wave 1: Phase 1 console

Milestone: `Wave 1: Console phase 1`

**Operator tasks before dispatch:**

1. Decide Stop (spec 0002, Stop, open decision). The plan assumes the orchestrator stop route.
2. Add `console` to `pnpm-workspace.yaml` (tier 3).
3. In `orchestrator/` (tier 3, human-authored): read routes for run records from the last 24 hours, the coordinator's queue and daily spend, and blocked issues and PRs waiting on approval; and the stop route from spec 0002. All require the Cloudflare Access identity of the repo owner.
4. Create the Cloudflare Access application and policy for the console's hostname in the factory account, owner only.

**Runs:** one at a time, because all five are `area:console`. Recommended cap: 1.

**Done when:** behind Access, the console shows the three Phase 1 sections from live orchestrator data on desktop and at 390px, and holding Stop on a test run ends it, with the orchestrator's comment on the PR.

**Data changes:** none. The console stores nothing; the dial or runway choice is kept in the browser.

**Depends on, outside this plan:** #13 (coordinator), #11 (stop), #10 (logs), and workflow-loop plan W1-4 (run records with cost).

### W1-1: Scaffold the console Worker behind Cloudflare Access

- **Area:** `area:console`
- **Expected tier:** 1, because it changes only `console/`
- **Run profile:** `standard-medium`, because it's a small Worker in an existing pattern (`orchestrator/`)
- **Data change:** none
- **Blocked by:** nothing; operator tasks 2 and 4 first

**Background.** The console is a Cloudflare Worker in the factory account (spec 0001, Later: operator console). Every request must carry a valid Cloudflare Access JWT for the repo owner; anything else gets 403. The likely wrong turn is trusting the identity header without verifying the JWT's signature and audience.

**Tasks**

- [ ] `console/` Worker with `GET /health` returning `<version>+<shortsha>`, and `GET /` serving a page that loads `design/tokens.css` and `design/components.css`.
- [ ] Verify the `Cf-Access-Jwt-Assertion` JWT on every request: signature against the team's certs, audience, expiry, and the owner's email. Fail closed.
- [ ] `make -C console check` running type check, lint and tests, matching `orchestrator/`.
- [ ] Tests for a missing JWT, an expired one, a wrong audience, another user's identity, and the owner's.

**Acceptance**

```bash
make -C console check
```

- A request without a valid owner JWT gets 403; `/health` with one returns the build id.

**References:** spec 0002 (hard constraints 6 and 9), `orchestrator/README.md`, Cloudflare Access JWT validation docs

### W1-2: Serve the Phase 1 data as one console endpoint

- **Area:** `area:console`
- **Expected tier:** 1, because it changes only `console/`
- **Run profile:** `standard-high`, because it joins three sources and computes the spend forecast
- **Data change:** none
- **Blocked by:** W1-1, operator task 3, #13, workflow-loop W1-4

**Background.** The screens need one JSON document: waiting items, runs from the last 24 hours, and spend today (`console/design/screens/phase-1.md`, Data each section needs). The console reads the orchestrator's routes with the operator's Access identity and holds no GitHub credential.

**Tasks**

- [ ] `GET /api/phase1` returning `{waiting, runs, spend, updatedAt}`, typed, built from the orchestrator's read routes.
- [ ] Order waiting items: blocked, tier 2 approval, failed, queue paused; oldest first within each.
- [ ] Spend: today's total, limit, burn rate over the last hour, forecast at midnight, and the pause time when the forecast passes the limit.
- [ ] Per-run costs sum to the spend total; when they don't, return both and flag the gap.
- [ ] Tests with fixture orchestrator responses for each waiting kind, an escalated run, a stopped run, and a forecast that passes the limit.

**Acceptance**

```bash
make -C console check
```

- The fixture with $41.20 spent at 14:20 and $6.40/h returns a pause time of 19:37.

**References:** spec 0002 (Phase 1), ADR-005 (daily spend), ADR-008 (run profiles)

### W1-3: Build the control room screen

- **Area:** `area:console`
- **Expected tier:** 1, because it changes only `console/`
- **Run profile:** `standard-medium`, because the design is specified to the pixel
- **Data change:** none
- **Blocked by:** W1-2

**Background.** The desktop screen at 1440px: header, then Waiting on you, Runs and Spend today in three columns, as in `console/design/reference/desktop.dc.html` and `desktop-states.dc.html`. Use the design's classes and tokens; don't restyle components. The likely wrong turn is approve or merge buttons: approvals always link out to GitHub.

**Tasks**

- [ ] The three sections from `/api/phase1`, refreshing every 15 seconds, per `console/design/screens/phase-1.md`.
- [ ] The spend gauge with its Dial/Runway toggle, the choice kept in local storage.
- [ ] The issue hover card on hover and keyboard focus.
- [ ] Feed lost after 30 seconds without an update: stale values struck through, cards desaturated, nothing blanked.
- [ ] Stop shown on running rows, disabled until W1-5.
- [ ] Tests rendering each Phase 1 key state from fixtures.

**Acceptance**

```bash
make -C console check
```

- With the working-state fixture, the page shows 3 waiting items, 7 runs and $41.20 on the gauge.

**References:** `console/design/` (README, `components/`, `screens/phase-1.md`, `reference/`)

### W1-4: Build the pager screen

- **Area:** `area:console`
- **Expected tier:** 1, because it changes only `console/`
- **Run profile:** `standard-medium`, because the design is specified to the pixel
- **Data change:** none
- **Blocked by:** W1-3

**Background.** Below 760px the console serves the pager layout: one column, the three sections stacked, spend as a strip (`console/design/reference/pager.dc.html`, `pager-states.dc.html`). It is a separate layout, not the desktop one squeezed (spec 0002, Avoid).

**Tasks**

- [ ] The pager layout from the same `/api/phase1` data.
- [ ] Running rows expanded with links and Stop (44px); other rows on one line.
- [ ] The healthy empty state, "Line running normally".
- [ ] Feed lost as on desktop.
- [ ] Tests at 390px for the working, healthy and feed-lost fixtures.

**Acceptance**

```bash
make -C console check
```

- At 390px wide, the page has no horizontal scroll and every Stop is at least 44px high.

**References:** `console/design/screens/phase-1.md`, spec 0002 (Two products)

### W1-5: Wire Stop to the orchestrator

- **Area:** `area:console`
- **Expected tier:** 1, because it changes only `console/`
- **Run profile:** `standard-high`, because it is the console's only action and must fail safe
- **Data change:** none
- **Blocked by:** W1-4, #11, operator task 3 (stop route)

**Background.** Stop is press-and-hold: 1.5 s fills the ring, then the console calls the orchestrator's stop route with the operator's Access identity and shows stopping until the run reports stopped (`console/design/components/Stop.md`). It keeps working when the feed is lost.

**Tasks**

- [ ] Press-and-hold with pointer and keyboard (Space or Enter held); releasing early does nothing.
- [ ] `POST` to the stop route; show the stop sequence from the run's events; show who stopped it and when.
- [ ] Stop stays available while the feed is lost; a stop started then confirms when the feed returns.
- [ ] Announce each state to screen readers.
- [ ] Tests: a short press sends nothing; a full hold sends one request; a failed request shows the error and leaves the run running.

**Acceptance**

```bash
make -C console check
```

- In the test harness, a 1.5 s hold sends exactly one stop request; a 1 s hold sends none.

**References:** spec 0002 (Stop, hard constraint 4), #11
