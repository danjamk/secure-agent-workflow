# Plan: Operator console, Phase 1

Status: Draft · Date: 2026-11-06 · Spec: [0002](../specs/0002-operator-console.md) (Phasing, Stop) · ADR: [010](../adr/ADR-010-console-stop-route.md) · Epic: #35

## Summary

Phase 1 of the operator console: one read-only screen per device showing what's waiting on the operator, runs from the last 24 hours and spend today, plus Stop on running rows. It is four human-authored issues, which add the console's workspace, gate and deploy and the orchestrator routes it reads from, and one wave of seven console issues that build against a fixed route contract. Design: `console/design/`, screens in `console/design/screens/phase-1.md`.

**Sequencing.** Phase 1 is not a build order step. It follows step 1's orchestrator work (#9 to #13, workflow-loop W1-4) and nothing waits on it.

- **The wave can start before #13 and W1-4.** Every console issue builds and tests against fixtures of the route contract below. It needs only H-1 and operator tasks 1 and 2. It does need a working build agent, so #9 first. Until #13 lands there's no queue or "blocked by" gating, so dispatch one issue at a time.
- **Earliest real data:** Waiting on you, once #9 and H-2 merge. Runs and Spend today, once #13 and W1-4 merge (W1-4 waits on #10 and workflow-loop W1-3), and then H-3. Stop, once #11 and H-4 merge.
- **Phase 1 is done** no earlier than the end of build order step 1.

| Wave | Goal | Issues | Tier 2 or 3 PRs | Runs | Recommended cap | Profiles |
| --- | --- | --- | --- | --- | --- | --- |
| Before the wave | Workspace, gate, deploy and orchestrator routes (human-authored) | 4 | 4 tier 3, authored by the operator | Not dispatched | — | — |
| 1 | Phase 1 console | 7 | 0 with operator task 1; 7 without it | One at a time | 1 | 2 standard-medium, 5 standard-high |

## Human-authored issues

These change tier 3 paths in this repo: `orchestrator/**`, `.github/**`, the root `package.json`, `pnpm-lock.yaml`, `pnpm-workspace.yaml` and `Makefile`. No agent may author them, so they are issues for the operator, like #9 to #13.

They are sub-issues of #35 with **no milestone**. `/dispatch` labels every open issue in the milestone it's given, and `wave-planning.md` keeps tier 3 out of waves, so the wave milestone holds only agent issues. The wave's issues link to these as "blocked by" where the dependency is real.

They have no `run:*` label, since no agent runs them. Otherwise they follow the issue template.

### H-1: Add the console to the workspace, the gate and the factory deploy

- **Area:** `area:console`
- **Expected tier:** 3, because it changes `pnpm-workspace.yaml`, `pnpm-lock.yaml`, `Makefile` and `.github/workflows/`
- **Author:** the operator
- **Data change:** none
- **Blocked by:** nothing

**Background.** Console issues can't add dependencies: the lockfile is tier 3 here. So this issue installs everything the wave needs, wires `make check` into the gate, and deploys the console like the orchestrator. The console is static assets plus a Worker that serves only `/health` (ADR-010, Topology).

**Tasks**

- [ ] `console/package.json` with dev dependencies only: `typescript`, `vitest`, `happy-dom`, `wrangler`, `@cloudflare/workers-types`, at the orchestrator's versions where shared. Scripts: `typecheck`, `test`, `build` (`tsc` to `console/dist`, then copy `index.html` and `design/*.css` into it), `check`.
- [ ] `console/tsconfig.json`, and `console/Makefile` with `check` matching `orchestrator/Makefile`.
- [ ] Add `console` to `pnpm-workspace.yaml`, update the root lockfile, and add `$(MAKE) -C console check` to the root `Makefile`.
- [ ] `console/wrangler.jsonc`: factory account, the console's hostname, static assets from `dist`, `run_worker_first` for `/health`, a `VERSION` variable. Stub `console/src/worker.ts` returning 404, so the build passes.
- [ ] `console/public/_headers` with `Content-Security-Policy: default-src 'self'; script-src 'self'; connect-src 'self'; style-src 'self'; frame-ancestors 'none'`.
- [ ] `.github/workflows/console-deploy.yml`: deploy on merge to `main` when `console/**` changes, through the `factory` environment, as `orchestrator-deploy.yml` does.

**Acceptance**

```bash
make check
```

- The deploy workflow's run on merge deploys the console, and its hostname answers only through Cloudflare Access.

**References:** ADR-010, `orchestrator/Makefile`, `.github/workflows/orchestrator-deploy.yml`, `.github/self-tier-map.yml`

### H-2: Verify the Access identity in the orchestrator and serve the waiting route

- **Area:** `area:orchestrator`
- **Expected tier:** 3, because it changes `orchestrator/**`
- **Author:** the operator
- **Data change:** none
- **Blocked by:** nothing. Real data needs #9, so agent PRs exist

**Background.** ADR-010 has the orchestrator verify the Cloudflare Access JWT on every `/api/*` request, so `/api/*` on its own hostname, which Access doesn't cover, gets 403. The waiting route reads GitHub with installation tokens the orchestrator already mints, so the console holds nothing.

**Tasks**

- [ ] An Access verifier per ADR-010: signature against the team's published keys (cached), `aud`, expiry, `email` equal to `OPERATOR_EMAIL`. New variables `ACCESS_TEAM`, `ACCESS_AUD`, `OPERATOR_EMAIL`. Fail closed.
- [ ] A Workers route sending `/api/*` on the console's hostname to the orchestrator. The webhook path stays outside Access.
- [ ] `GET /api/waiting` per the contract below: blocked issues with the **Question** line of the latest handoff note, open agent PRs waiting on the owner's approval with their tier line, and agent PRs with a failed check. Across `ALLOWED_REPOS`, cached for 10 seconds.
- [ ] Every response carries `generatedAt` and `operator`.
- [ ] Tests: a missing, badly signed, wrong-audience and expired JWT, another email, and the owner's; each waiting kind from fixture GitHub responses; the webhook path unaffected.

**Acceptance**

```bash
make -C orchestrator check
```

- On the deployed console's hostname, `GET /api/waiting` returns the owner's items; on the orchestrator's own hostname it returns 403.

**References:** ADR-010, spec 0002 (Phase 1), `console/design/screens/phase-1.md` (Data each section needs), `orchestrator/README.md`

### H-3: Serve the runs and factory routes

- **Area:** `area:orchestrator`
- **Expected tier:** 3, because it changes `orchestrator/**`
- **Author:** the operator
- **Data change:** none, it reads existing records
- **Blocked by:** H-2, #13, workflow-loop W1-4

**Background.** Runs and Spend today read the run records (W1-4) and the coordinator (#13, ADR-005). Some fields need data those issues don't record yet (Gaps, below). Return them as `null` until they do; the console shows a dash.

**Tasks**

- [ ] `GET /api/runs?since=<time>` per the contract: runs started or ended since then, newest first, across `ALLOWED_REPOS`, at most 24 hours back.
- [ ] `GET /api/factory` per the contract: spend for the current UTC day, limit, paused, reset time, hourly spend series, slots, queue counts, active milestones, merged today.
- [ ] Tests for a running, escalated, stopped and failed run, a paused queue, and a day with no runs.

**Acceptance**

```bash
make -C orchestrator check
```

- With one live run on the testbed, `GET /api/runs` on the console's hostname lists it as `running` with its profile and model.

**References:** spec 0002 (Phase 1), ADR-005 (daily spend), ADR-008 (run profiles), workflow-loop plan W1-4

### H-4: Add the stop route

- **Area:** `area:orchestrator`
- **Expected tier:** 3, because it changes `orchestrator/**`
- **Author:** the operator
- **Data change:** `expand`, two-way: stop steps with times on the run's state
- **Blocked by:** H-2, #11

**Background.** ADR-010: `POST /api/runs/<repo>/<issue>/stop` runs #11's stop for the Access-verified operator, then labels and comments in GitHub with the App's token. It must work when GitHub reads fail, because Stop survives a lost feed (spec 0002, hard constraint 7).

**Tasks**

- [ ] The route, with ADR-010's checks in order: JWT and email, `Content-Type: application/json`, `Origin` equal to the console's hostname, repo in `ALLOWED_REPOS`, a live run.
- [ ] Run #11's stop, then add `agent:stop` and comment on the PR: "Stopped by `<APPROVER_LOGIN>` from the operator console."
- [ ] Record the stop steps with times (`requested`, `token_revoked`, `sandbox_torn_down`), `stoppedBy` and `stoppedAt`, and return them in `/api/runs`.
- [ ] Return 202 with the run's state; a second stop on the same run returns 202 and changes nothing.
- [ ] Tests under `test:security`: each failed check changes nothing; the owner's stop ends network access for the run; a stop while GitHub reads fail still stops the run.

**Acceptance**

```bash
make -C orchestrator check
```

- A stop from the deployed console ends a testbed run, and the PR shows the label and the comment.

**References:** ADR-010, #11, spec 0002 (Stop)

## Route contract

H-2 to H-4 serve this, and the wave builds against it. All times are ISO 8601 UTC, money is USD as a number, and a field the orchestrator can't fill yet is `null`. A change goes through a PR to this plan first.

```ts
type Operator = { email: string; login: string };

// GET /api/waiting
type Waiting = {
  generatedAt: string; operator: Operator;
  items: Array<{
    kind: "blocked" | "approval" | "failed";
    repo: string; since: string;
    issue: { number: number; title: string; url: string; area: string | null };
    question: string | null;      // blocked: the handoff note's Question line, as plain text
    replyUrl: string | null;      // blocked: the handoff note comment
    pr: { number: number; title: string; url: string; tierLine: string | null;
          tierFiles: string[]; checksPassed: number; checksTotal: number } | null;
    failedCheck: { name: string; url: string } | null;   // failed
    profile: string | null; runs: number | null; costUsd: number | null;  // failed
  }>;
};

// GET /api/runs?since=<time>
type Runs = {
  generatedAt: string; operator: Operator;
  runs: Array<{
    id: string; repo: string;
    issue: { number: number; title: string; url: string; area: string | null;
             milestone: string | null; expectedTier: 1 | 2 | 3 | null;
             holdsLock: boolean | null; blocks: number[] };
    state: "queued" | "waiting" | "running" | "blocked" | "in review" | "merged" | "failed" | "stopped";
    startedAt: string; endedAt: string | null;
    profile: string; model: string; escalated: boolean;
    costUsd: number | null; budgetUsedPct: number | null;
    prUrl: string | null; logUrl: string | null;
    stoppedBy: string | null; stoppedAt: string | null;
    stopSteps: Array<{ step: "requested" | "token_revoked" | "sandbox_torn_down"; at: string }>;
  }>;
};

// GET /api/factory
type Factory = {
  generatedAt: string; operator: Operator;
  spend: { todayUsd: number; limitUsd: number; paused: boolean; resetsAt: string;
           hourly: Array<{ hour: string; usd: number }> | null };
  slots: { used: number; cap: number };
  queued: number; queuedBehindSpend: number;
  milestones: Array<{ repo: string; title: string }>;
  mergedToday: number;
};

// POST /api/runs/<repo>/<issue>/stop, body {}, Content-Type: application/json
// 202 { runId: string; state: "stopping" | "stopped" }
```

## Wave 1: Phase 1 console

Milestone: `Wave 1: Console phase 1`

**Operator tasks before dispatch:**

1. **Make console code tier 1** in `.github/self-tier-map.yml` (tier 3). Recommended: tier 1 `console/src/**`, `console/test/**`, `console/index.html`; tier 2 `console/package.json`, `console/tsconfig.json`, `console/wrangler.*`, `console/public/**`. Today every console path is unmatched, so tier 2, and the wave would be seven approvals against a guideline of three. The console holds no credential and no authority (ADR-010), so its UI code is low risk.
2. **Create the Cloudflare Access application** for the console's hostname in the factory account, allowing only the operator's email. Set `ACCESS_TEAM`, `ACCESS_AUD` and `OPERATOR_EMAIL` on the orchestrator.
3. Merge H-1 before dispatching W1-1.

**Runs:** one at a time, because all seven are `area:console`. Recommended cap: 1.

**Done when:** behind Access, the deployed console shows the three Phase 1 sections from live data on desktop and at 390px, and holding Stop on a testbed run ends it, with the orchestrator's comment on the PR. With only the wave merged, the same screens render from fixtures in tests.

**Data changes:** none. The console stores nothing; the Dial or Runway choice is kept in the browser's local storage.

**Depends on, outside this plan:** H-1 to H-4; #9, #10, #11, #13 and workflow-loop W1-4 through them.

**Rules for every issue in this wave** (repeated in each issue's Background):

- Change only `console/`. Never edit `console/design/`. If the design lacks something, block and ask; design changes go through Claude Design.
- Add no dependency. The lockfile is tier 3 here; H-1 installed what the wave needs. If you need another, block and ask.
- Never put approve or merge in the console. Approve, reply and every other action except Stop are links out to GitHub.

### W1-1: Serve the console shell and a typed data client

- **Area:** `area:console`
- **Expected tier:** 1, because it changes `console/src/**`, `console/test/**` and `console/index.html` (2 without operator task 1)
- **Run profile:** `standard-medium`, because it's a small Worker and a typed client in an existing pattern
- **Data change:** none
- **Blocked by:** H-1

**Background.** The console is static assets plus a Worker that serves `/health` (ADR-010). The page calls the orchestrator's routes same-origin; the console holds no credential. The fixtures written here are what every later issue tests against, so they follow spec 0002's example data exactly. Wave rules above apply.

**Tasks**

- [ ] `src/worker.ts`: `GET /health` returns `<version>+<shortsha>` from `VERSION`; anything else 404.
- [ ] `index.html` loading `tokens.css`, `components.css` and `app.js`, with an empty root element.
- [ ] `src/api.ts`: types and fetch functions for the three read routes and the stop route, exactly as in the plan's route contract. A malformed response throws a typed error; it never returns partial data.
- [ ] Fixtures in `test/fixtures/` for: working, healthy, paused for spend, stopping, stopped. Working is spec 0002's example data: waiting #48 blocked, #47 approval, #46 failed; seven runs (#40 and #41 merged, #42 and #50 running with #50 escalated, #46 failed, #47 in review, #48 blocked); $41.20 of $75 at 14:20 UTC, $6.40 in the 13:00 UTC hour; slots 2 of 3.
- [ ] Tests: `/health`, each fixture parses, and a response missing a required field throws.

**Acceptance**

```bash
make -C console check
```

- `GET /health` on the deployed console returns the build id.

**References:** ADR-010, this plan's route contract, spec 0002 (Example data), `orchestrator/src/index.ts` for `/health`

### W1-2: Compute the Phase 1 view model

- **Area:** `area:console`
- **Expected tier:** 1, because it changes `console/src/**` and `console/test/**` (2 without operator task 1)
- **Run profile:** `standard-high`, because the forecast and feed-state rules are easy to get subtly wrong
- **Data change:** none
- **Blocked by:** W1-1

**Background.** Pure functions from the three route responses to what each section shows (`console/design/screens/phase-1.md`). The spend day is the UTC day, because the coordinator totals and resets per UTC day (ADR-005). The likely wrong turn is forecasting to local midnight. Wave rules above apply.

**Tasks**

- [ ] Waiting: order blocked, approval, failed; oldest first within each; add a queue-paused item when `spend.paused` and `queuedBehindSpend > 0`.
- [ ] Runs: newest first by start time.
- [ ] Spend: burn rate from the last full hour of `hourly`; forecast at `resetsAt`; pause time and time left when the forecast passes the limit, else "within limit today"; caution at 80% of the limit; when `paused`, "paused · resets <time>".
- [ ] Cost check: per-run costs today must sum to `todayUsd` within one cent; when they don't, return both and a flag.
- [ ] Feed state: live until 30 seconds pass without a successful fetch, then lost with the time since the last one.
- [ ] Tests for each rule, using W1-1's fixtures.

**Acceptance**

```bash
make -C console check
```

- The working fixture gives a forecast of $103 and a pause at 19:37 UTC, 5h 17m left.

**References:** spec 0002 (Phase 1), `console/design/screens/phase-1.md`, `console/design/components/EnvelopeDial.md`, ADR-005 (daily spend)

### W1-3: Render the Phase 1 components

- **Area:** `area:console`
- **Expected tier:** 1, because it changes `console/src/**` and `console/test/**` (2 without operator task 1)
- **Run profile:** `standard-high`, because it's eight components, each with several states
- **Data change:** none
- **Blocked by:** W1-2

**Background.** Render functions that return DOM nodes using `components.css` classes, for AlarmCard, StatusGlyph, IssueToken with its hover card, Key (link-out), FeedStatus, LogStep, BulletBar and Stop (visual states only; W1-7 wires it). Match `console/design/reference/` for copy and structure. The likely wrong turn is `innerHTML` with run data: titles and questions are written by agents, and a script injected into this page could call the stop route. Set text with `textContent` only. Wave rules above apply.

**Tasks**

- [ ] Each component per its spec in `console/design/components/`, taking view model types from W1-2.
- [ ] All data text through `textContent`; links only to `https://github.com/` or the run's `logUrl`.
- [ ] AlarmCard: blocked, approval, failed and queue-paused, with their link-outs. No answer chips in Phase 1 (Gaps, below).
- [ ] Stop: idle, holding with a percentage, stopping, stopped, as markup and ARIA state.
- [ ] Tests rendering each component state with happy-dom, including a title containing `<script>`, which renders as text.

**Acceptance**

```bash
make -C console check
```

- A run titled `<img src=x onerror=alert(1)>` renders as that literal text.

**References:** `console/design/components/`, `console/design/reference/`, spec 0002 (Shared patterns)

### W1-4: Render the spend gauge

- **Area:** `area:console`
- **Expected tier:** 1, because it changes `console/src/**` and `console/test/**` (2 without operator task 1)
- **Run profile:** `standard-high`, because the dial and runway faces are SVG geometry
- **Data change:** none
- **Blocked by:** W1-2

**Background.** The `EnvelopeDial` spend gauge, both faces, and the pager's collapsed strip (`console/design/components/EnvelopeDial.md`, `phase-1.md` section 3). The runway's cone needs the hourly series; when `hourly` is `null`, draw the projection without the cone. Wave rules above apply.

**Tasks**

- [ ] Dial face: needle, forecast pointer, readouts, forecast chip, runway line, zones from the view model.
- [ ] Runway face: today's line, the dashed projection, the cone from hourly variance, the caution and limit bands, the crossing marker.
- [ ] The Dial/Runway toggle (`oc-seg`), with the choice saved to local storage inside try/catch; Dial when storage fails.
- [ ] The pager strip: spend and limit, bullet bar, runway line, burn rate and forecast.
- [ ] The paused-for-spend state.
- [ ] Tests for each face with the working and paused fixtures, and with `hourly` null.

**Acceptance**

```bash
make -C console check
```

- With the working fixture, the dial reads $41.20, the chip "◇ $103 by 24:00 UTC" and the runway line "pauses 19:37 · 5h 17m".

**References:** `console/design/components/EnvelopeDial.md`, `console/design/components/BulletBar.md`, `console/design/reference/desktop.dc.html`, `desktop-states.dc.html`

### W1-5: Build the control room screen

- **Area:** `area:console`
- **Expected tier:** 1, because it changes `console/src/**` and `console/test/**` (2 without operator task 1)
- **Run profile:** `standard-high`, because it adds the app shell every screen uses: refresh loop, feed state and layout switch
- **Data change:** none
- **Blocked by:** W1-3, W1-4

**Background.** The 1440px screen: header, banner row, then Waiting on you (400px), Runs (fluid) and Spend today (320px), as in `desktop.dc.html` and `desktop-states.dc.html`. No tabs, line view or run panel. Wave rules above apply.

**Tasks**

- [ ] `src/app.ts`: fetch the three read routes every 15 seconds, build the view model, render; the pager layout below 760px wide (`matchMedia`), rendered by W1-6.
- [ ] Header: product name, repos and active milestones, slots, merged today, feed status, operator login.
- [ ] Banner row for queue paused for spend and for feed lost.
- [ ] Runs table per `phase-1.md`: columns, 52px running rows, "▲ escalated", stopped-by in the profile column, "6 more today" past the cutoff.
- [ ] Hover card on hover and on keyboard focus.
- [ ] Feed lost: stale values struck through, cards desaturated (`oc-degraded`), "running?", nothing blanked.
- [ ] Tests rendering each fixture, and feed lost after 30 seconds without a fetch.

**Acceptance**

```bash
make -C console check
```

- With the working fixture, the page shows 3 waiting items, 7 runs and $41.20 on the gauge.

**References:** `console/design/screens/phase-1.md`, `console/design/reference/desktop.dc.html`, `desktop-states.dc.html`

### W1-6: Build the pager screen

- **Area:** `area:console`
- **Expected tier:** 1, because it changes `console/src/**` and `console/test/**` (2 without operator task 1)
- **Run profile:** `standard-medium`, because the shell and components exist and the layout is specified
- **Data change:** none
- **Blocked by:** W1-5

**Background.** Below 760px the console renders the pager: one column, the three sections stacked, spend as the strip (`pager.dc.html`, `pager-states.dc.html`). It is its own layout, not the desktop one squeezed (spec 0002, Avoid). Wave rules above apply.

**Tasks**

- [ ] The pager layout from the same view model.
- [ ] Running rows expanded with links and Hold to stop; other rows on one line.
- [ ] The healthy state, "Line running normally", with the merged-today line.
- [ ] Feed lost as on desktop.
- [ ] Tests for the working, healthy and stopped fixtures in the pager layout.

**Acceptance**

```bash
make -C console check
```

- On the deployed console at 390px wide, the page has no horizontal scroll and each Stop is at least 44px high.

**References:** `console/design/screens/phase-1.md`, `console/design/reference/pager.dc.html`, `pager-states.dc.html`, spec 0002 (Two products)

### W1-7: Wire Stop to the orchestrator

- **Area:** `area:console`
- **Expected tier:** 1, because it changes `console/src/**` and `console/test/**` (2 without operator task 1)
- **Run profile:** `standard-high`, because it's the console's only action and must fail safe
- **Data change:** none
- **Blocked by:** W1-6

**Background.** Hold 1.5 seconds to fill the ring, then one `POST` to the stop route (ADR-010), then the stop steps from `/api/runs` until the run reads `stopped` (`console/design/components/Stop.md`). It builds against the contract; end to end it needs H-4. Stop keeps working when the feed is lost. Wave rules above apply.

**Tasks**

- [ ] Press-and-hold with pointer and keyboard (Space or Enter held); releasing early sends nothing.
- [ ] One `POST` with `Content-Type: application/json` and body `{}`; poll `/api/runs` every 2 seconds while stopping.
- [ ] Show the stop steps as they arrive, then who stopped it and when.
- [ ] While the feed is lost, Stop still sends, and shows "confirms when the feed returns" until the run reads `stopped`.
- [ ] A failed request shows the error and leaves the row running.
- [ ] Announce each state through an `aria-live` region.
- [ ] Tests with fake timers: a 1-second hold sends nothing, a 1.5-second hold sends exactly one request, a repeated hold on a stopping run sends nothing, a 500 leaves the row running.

**Acceptance**

```bash
make -C console check
```

- Holding Stop on a testbed run from the deployed console ends it, and the PR shows "Stopped by" the operator.

**References:** ADR-010, `console/design/components/Stop.md`, spec 0002 (Stop, hard constraint 4), #11

## Gaps

Things the console needs that the dependencies or the design don't provide. None of them widens #9 to #13 here; the operator decides each one.

**In #9 to #13 and workflow-loop W1-4:**

1. **Workflow-loop W1-4 isn't an issue yet.** That plan's issues haven't been created, so H-3 can't link to it as "blocked by". Recommended: create workflow-loop wave 1's issues before this plan's.
2. **Live cost of a running run** (W1-4, #10). Both record cost when the run ends. Running rows, budget use and the burn rate need it during the run. ADR-005 already has the outbound handler report spend to the coordinator, so the data exists in #13. Recommended: W1-4 records cost and token use as it accrues.
3. **Hourly spend series** (#13). The coordinator totals per UTC day but keeps no series. The runway chart and the burn rate need one. Recommended: #13 keeps per-hour totals for the current day.
4. **Stop steps and who stopped** (#11, W1-4). Neither records stop steps with times, `stoppedBy` or `stoppedAt`. H-4 adds them for console stops only; a label stop wouldn't show them. Recommended: #11 records them for every stop.
5. **One Access application for logs and the console** (#10). #10 serves logs "behind Cloudflare Access" but doesn't say on which hostname or that the Worker verifies the JWT. Recommended: #10 serves logs under `/api/` on the console's hostname and uses H-2's verifier, so one Access application and one check cover both.
6. **A run index by time** (W1-4). W1-4 reports per milestone; the runs route needs every run in the last 24 hours across repos. H-3 can scan run records while there are few; past that, W1-4 needs an index.

**In the design (changes go through Claude Design):**

1. **Answer chips can't pre-fill a GitHub reply.** GitHub has no URL that pre-fills a comment on an existing issue or PR, and the handoff note format (`standards/agent-instructions.md`) has one recommended answer, not a list of choices. Recommended: drop the chips from Phase 1; Reply in GitHub stays.
2. **"By 24:00" and "resets 00:00" assume local midnight.** The coordinator's day is the UTC day (ADR-005). Recommended: the chip and reset line show UTC ("by 24:00 UTC"), as W1-2 and W1-4 do; or ADR-005 moves to the operator's time zone.
3. **No state for a missing PR audit.** Approval cards show an audit result, but the PR audit (#21) isn't built. Recommended: a "no audit" state on the approval card.
4. **The reply link for a blocked run with no PR.** `phase-1.md` links to an issue comment when there's no PR. The agent instructions always put the handoff note on the PR, so that case shouldn't occur. No change needed unless #11 allows a block before the first push.
