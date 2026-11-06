# Phase 1 screens

Two screens, one per device, plus their states. Phase 1 is read-only except for Stop (spec 0002, Phasing). The approved artboards are in `../reference/`; this file says what each part shows, where its data comes from, and how it behaves.

| Artboard | Screen | States shown |
| --- | --- | --- |
| `pager.dc.html` | Pager, 390px | Working: items waiting, two running runs |
| `pager-states.dc.html` | Pager, 390px | Healthy (nothing waiting); Stop being held and a run stopping; feed lost with a stopped run |
| `desktop.dc.html` | Control room, 1440px | Working, with the issue hover card open |
| `desktop-states.dc.html` | Control room, 1440px | Queue paused for spend, feed lost, a run stopping, a run stopped, Runway face |

## Layout

**Pager:** one scrolling column. Header (product name, feed status, operator login), then the three sections stacked: Waiting on you, Runs, Spend today. No tabs and no second screen.

**Control room:** header across the top (product name, repos and active waves, slots used, merged today, feed status, operator login), then three columns: Waiting on you (400px), Runs (fluid), Spend today (320px). A banner row appears under the header for a factory-wide condition (queue paused for spend, feed lost).

## 1. Waiting on you

Items that need the operator, as `AlarmCard`s. Order: blocked, then tier 2 approvals, then failed runs; oldest first within each. The heading shows the count.

| Kind | Shows | Links out |
| --- | --- | --- |
| Blocked | The agent's question quoted from its handoff note, issue number and title, repo, `area:` label, age | Answer chips when the question has discrete answers (each opens the GitHub reply pre-filled); Reply in GitHub: the issue comment holding the handoff note if no PR exists, else the PR |
| Tier 2 approval | Tier tag, PR number and title, one-line reason (from the tier line at the top of the PR), checks passed/total, audit result, changed files that set the tier | Approve in GitHub (the PR); Files (desktop) |
| Failed | Issue, the failing check, profile, number of runs including escalation, cost | Check run; PR |
| Queue paused for spend | How many issues are queued behind the limit | The queue in GitHub |

An item leaves the list when it is resolved in GitHub. There is no acknowledge in Phase 1.

Empty state: a well with a check glyph, "Line running normally", and one line of context ("No blocked runs, approvals or failures. 9 merged today.").

## 2. Runs

Runs from the last 24 hours, newest first, across all watched repos. Older runs link out ("All runs ↗", "6 more today").

**Desktop row** (`desktop.dc.html`), columns: state (`StatusGlyph` with word), issue (`IssueToken`), title, elapsed, profile and model, cost, links (PR, Log; Issue when there is no PR), Stop. Running rows are 52px and tinted; others 44px. An escalated run shows "▲ escalated" after its title. A stopped run shows who stopped it and when in the profile column.

**Pager row** (`pager.dc.html`): running rows expand to show state, issue, elapsed and cost, the title, profile and model with budget use, PR and Log links, and Hold to stop (44px). Other rows collapse to one line: state, issue, title, cost (or who stopped it and when).

**Hover card** (desktop only): hovering or focusing an issue token opens `oc-hover` with title, state and elapsed, repo, wave, area and whether it holds the lock, profile, expected tier, budget use, and what it blocks. Clicking the token opens the issue in GitHub in Phase 1.

## 3. Spend today

**Desktop:** the `EnvelopeDial` spend gauge, Dial face by default, with the Dial/Runway toggle; the choice is remembered per device. Below it, cost by run today: the top four as bullet bars, then "+ N more · $X total". Per-run costs must add up to the gauge's value.

**Pager:** a collapsed strip: spend and limit, a bullet bar, the runway line ("pauses 19:37 · 5h 17m"), and the burn rate with the end-of-day forecast. When spend stays within the limit at the current rate, the runway line reads "within limit today".

**Paused for spend:** the gauge value turns `failed`, the runway line reads "paused · resets 00:00", the caution lamp "▲ QUEUE paused for spend" and a banner explain it, and queued issues carry the `spend` wait reason.

## Stop

Every running row has Stop (`Stop` component). It is never in a menu.

1. **Idle:** "Hold to stop".
2. **Holding:** the ring fills over 1.5 s; the pager label reads "Keep holding · 62%" with "Release now to cancel" under it. Releasing early does nothing.
3. **Stopping:** the control breathes and is disabled; a log under it shows the steps as they arrive: stop requested by the operator, installation token revoked, sandbox torn down.
4. **Stopped:** the row shows `stopped`, who stopped it and when, the completed log, and a link to the PR comment the orchestrator posts.

Stop calls the orchestrator's owner-authenticated stop route (spec 0002, Stop). While the feed is lost, Stop still works; a stop started then shows "confirms when the feed returns" until the run reports stopped.

## Feed lost

When the console stops receiving updates: the header's feed chip turns to caution stripes with the time since the last update ("FEED LOST 00:14"), a notice reads "Showing the last update from 09:43. Stop still works.", cards and the gauge desaturate (`oc-degraded`), values that may be stale are struck through, and running states read "running?". Nothing is blanked.

## Data each section needs

| Section | Source |
| --- | --- |
| Waiting on you | GitHub: issues labeled `agent:blocked` with their handoff note; open agent PRs whose tier check is waiting on approval; check runs for failed PRs |
| Runs | The orchestrator's run records (workflow-loop plan W1-4): issue, profile, model, tokens, cost, wall-clock, outcome, escalations |
| Spend today | The coordinator's daily spend and limit (ADR-005); burn rate and forecast computed from today's run records |
| Feed status | Time of the last successful update from the orchestrator |
| Operator login | The Cloudflare Access identity |
