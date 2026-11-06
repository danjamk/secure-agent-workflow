# Spec 0002: Operator console

Status: Draft · Owner: Dan Kuhn · Created: 2026-11-05

The operator console from spec 0001 (Later: operator console): a console on Cloudflare, behind Cloudflare Access, in the factory account with the orchestrator. This spec is its design brief. The visual system and the approved Phase 1 screens are in `console/design/`.

**Build Phase 1 first** (Phasing). Everything after Phasing is the long-term direction, expected to change once Phase 1 is in use.

## What this is

An operator console for the software factory: build agents pick up GitHub issues, work in sandboxes, open pull requests, and ship through the merge gate. One operator supervises it: dispatches work, answers agents when they're blocked, approves tier 2 PRs, and stops anything that goes wrong.

It should feel like operating a machine: an industrial control room with cockpit instruments and trading-terminal density (`console/design/README.md`).

## Two products, one system

These are deliberately different designs, not one responsive layout.

- **Mobile: the pager.** A plant operator's handheld. It exists to respond: see what needs the operator, act on it or hand off to GitHub, check on a run, stop it if needed. Opened mostly from a Slack notification that deep-links to one item. Sessions last under a minute.
- **Desktop: the control room.** The whole factory on one screen, with drill-down to any wave or run. Used for work sessions: dispatching a wave, watching it run, investigating a problem.

## Phasing

Each phase ships, gets used, and reshapes the next one.

### Phase 1: observability, plus Stop

Read-only except for one action, Stop. The console answers three questions and links out for anything else; GitHub and Claude Code stay the places where work happens. Screens: `console/design/screens/phase-1.md`.

1. **What's waiting on me.** Blocked runs with the agent's question, tier 2 PRs awaiting approval, and failed runs. Each item shows enough context to decide without opening it, plus a link to where it gets handled (issue, PR, check run).
2. **What's running, recently finished, or errored.** Runs from the last 24 hours, newest first: running, merged, failed, stopped. Each row: issue, state, elapsed time, profile and model, cost, with links to the PR, the run log and the gate checks.
3. **Costs.** Spend today against the daily limit, as a needle gauge with a forecast marker for the end of day and a runway readout ("pauses 19:37"), with a toggle to the day-runway chart. Cost per run in the run rows.

**Stop** sits on every running row, on both screens, as a press-and-hold control (hard constraint 4). See Stop below for how it reaches the orchestrator.

Screens:

- **Pager: one screen**, the three sections stacked in that order, with the spend gauge collapsed to a strip. Stop on each running row, at least 44px high.
- **Control room: one screen**, the three sections side by side. Issue tokens get the hover card. No tabs, line view or run panel.
- **Feed lost** state on both.

Out of Phase 1: acknowledge, dispatch, production lines, the line view, the run panel, and the Review, Deploys, Metrics and Controls tabs. Acknowledge needs console-side state; in Phase 1 an item leaves the list when it is resolved in GitHub.

Depends on: the coordinator (#13), stop in the orchestrator (#11), per-run logs (#10), and run records with cost (workflow-loop plan W1-4).

### Later phases

Candidates, in no fixed order, chosen after using Phase 1: acknowledge, the run panel, production lines and the line view, dispatch, and the remaining tabs. The current best guess for that direction:

- Pager: Alarms (home), Wave runs, Run check. Deep links open Alarms with an alarm expanded, or Run check, with a path back to Alarms.
- Control room tabs: Floor (home), Review, Deploys, Metrics, Controls. The Floor drills down to a Line view and a Run panel (side panel, or full page from a deep link) with Telemetry, Log and Audit tabs.
- Overlays: the annunciator (from master caution), the shift handover (first visit of the day), the issue hover card, feed lost.

## Stop

#11 honors `agent:stop` only when the repo owner adds it, and spec 0001 says the console holds no credential the orchestrator doesn't already hold. The console therefore can't add the label itself without a new credential.

**Proposed (needs decision):** the console calls a stop route on the orchestrator, `POST /runs/<repo>/<issue>/stop`, reachable only through Cloudflare Access with the owner's identity. The orchestrator verifies the Access identity is the repo owner, sets the run's stop flag (the same flag `agent:stop` sets), revokes the installation token, tears down the sandbox, adds `agent:stop` with the App's token so the label history shows the stop, and comments on the PR "Stopped by <owner> from the operator console". The console holds no GitHub credential, and the audit trail stays in GitHub.

Alternative: the console signs the operator in with GitHub and adds `agent:stop` with the operator's user token. The label then comes from the owner's login and #11 works unchanged, but the console holds a user token with `issues: write`, which spec 0001 rules out.

The route is in `orchestrator/`, which is tier 3 in this repo, so it is human-authored.

## Domain concepts (use these terms exactly)

- **Issue:** one unit of work, sized for one agent run and one PR.
- **Wave:** a group of issues dispatched together (one GitHub milestone), with "blocked by" dependencies between them.
- **Run:** one agent working one issue in one sandbox. States: queued, waiting, running, blocked, in review, merged, failed, stopped.
- **Waiting reasons:** blocker not merged, area lock held by another issue, no free run slot, queue paused for spend. An issue can have more than one; show one primary badge and list the rest on detail.
- **Area lock (interlock):** each issue has exactly one `area:` label. One issue holds an area at a time, from sandbox start until its PR merges (ADR-005).
- **Run slots:** the coordinator's concurrency cap. Each wave plan also recommends a cap.
- **Tier:** PR risk. Tier 1 merges on green checks. Tier 2 (dependencies, auth, migrations, deploy config) waits for the owner's approval in GitHub. Tier 3 (`.github/**`, `CODEOWNERS`, the tier map) is human-authored: agents cannot push it, so it never appears as an agent PR. It appears as an operator task before dispatch, and later on the Controls tab as a rejected push.
- **Run profile:** model class and effort, e.g. `run:standard-medium`. A failed run is retried once at the next class up, an escalation (ADR-008).
- **Budgets:** per run, a token budget and wall-clock limit; for the factory, a daily spend limit that pauses the queue when reached.
- **Blocked:** the agent needs input (`agent:blocked`). It leaves a handoff note with a question and exits. The owner's reply resumes it.
- **Stop:** ends a run (Stop, above; #11). Enforced by the orchestrator and the outbound handler, not by the agent.
- **Environments:** preview (per branch) and staging (`main`) deploy to the dev target; production deploys to the prod target through a release PR. Show the environment by default and the target on the Deploys tab.

## Hard constraints

1. **Few actions.** Dispatch a wave, re-dispatch an issue, stop a run, acknowledge an alarm. The console never approves or merges; "Approve" always links out to GitHub, styled as leaving the console.
2. **Mobile actions are Stop and acknowledge only.** Dispatch and re-dispatch exist only on desktop. Replying to a blocked agent links out to GitHub: the issue comment holding the handoff note if no PR exists yet, otherwise the PR.
3. **Read-only first.** Phase 1 is read-only plus Stop. When dispatch arrives, it first shows the exact `/dispatch` command or label to apply.
4. **Stop is the andon cord:** press-and-hold with a filling ring, never in a menu, with a clear stopping → stopped sequence (token revoked, sandbox torn down).
5. **No secrets on screen.** Credentials appear by name and status only. Logs arrive redacted (#10); show the `[redacted]` token style.
6. **The operator is the Cloudflare Access identity.** Show it quietly; stops are recorded under it.
7. **The critical path survives a lost feed.** Master caution, the andon strip and Stop keep working when the rich views or the data feed fail, and show a distinct degraded state ("feed lost · 00:14") so the operator knows what is stale.
8. **Dark theme only** for now.
9. **No new credentials** (spec 0001). The console reads through the orchestrator and acts through it.

## Shared patterns

- **One alarm object, three densities.** The pager alarm card, the desktop "Needs you" item and the deep-link landing are one component (`AlarmCard`). Later, acknowledge syncs across devices.
- **Ghosted until it matters.** Issue tokens are outlines when normal; running gets the blue signal; only blocked, failed and approval get solid fill. A healthy factory is unlit.
- **One-click recommended response.** When an agent's question has discrete answers, show them as chips that open the GitHub reply pre-filled. Still a link out.
- **Issue hover card (desktop only).** Hovering or focusing an issue token shows title, state, area and lock, profile, tier, budget use, wait reasons and what it blocks.

## Example data

The reference screens use this data. It is illustrative.

- Repos: `agent-testbed`, `secure-agent-workflow`, and the reference build.
- Wave "Workflow loop, wave 1", 12 issues, including #41 merged, #42 running (`area:orchestrator`, 18 min, 61% of token budget), #43 waiting on #42, #44 waiting on #43 and on the `area:orchestrator` lock, #47 in review (tier 2, adds a dependency), #48 blocked ("Use `/health` or `/api/health`?"), #50 escalated to frontier and running.
- Spend today: $41.20 of $75, burning $6.40/h, $103 projected by midnight, so the queue pauses at 19:37. Slots: 2 of 3.

## Key states

Phase 1: healthy (nothing waiting), a blocked run, a tier 2 PR waiting, a failed run, spend projected to pass the limit, paused for spend, Stop being held, a run stopping, a run stopped with who and when, feed lost with Stop still available. All are in `console/design/reference/`.

## Avoid

Approve or merge buttons; any secret value; charts with no decision attached; Stop in a menu; a desktop layout squeezed onto a phone; generic dashboard filler.

## Open decisions

- [ ] Stop: orchestrator stop route behind Access (proposed) or a GitHub user token (Stop, above).
- [ ] Which items link to a Claude Code session instead of GitHub, and what that link is.

## References

- Spec 0001: Observability and intervention; Later: operator console
- ADR-005 (coordinator, daily spend), ADR-008 (run profiles)
- `console/design/` (design system and Phase 1 screens)
- #35 (the console placeholder issue), #11 (stop), #10 (logs), #13 (coordinator)
