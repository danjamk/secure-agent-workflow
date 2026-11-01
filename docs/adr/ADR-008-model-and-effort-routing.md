# ADR-008: Each issue carries a run profile, chosen by the plan and capped by the orchestrator

Status: Proposed · Date: 2026-11-01

## Context

Model choice and effort level are the largest cost lever in this system, and the largest quality lever. A frontier model at high effort on a rename wastes money. A small model on a foundation issue fails, gets resumed, gets a catch-up run, and costs more than the frontier run would have. Review capacity is the scarcest resource (spec 0001, Work units), so a cheap run that produces a PR the approver has to send back is the most expensive outcome of all.

Today nothing chooses. Spec 0001 lists "builder and reviewer model families" as an open decision, and the per-run budget is one number for every issue.

Three constraints shape the design:

- **Vendor-neutral** (spec 0001, goal 3). Plans can't name a model; models change faster than plans.
- **The agent must not choose its own budget.** Anything the agent can edit is not a control, and the agent App can edit labels.
- **The choice has to get better over time.** A first guess per issue is fine if the retrospective compares it with what the run actually cost.

## Decision

**Run profiles.** A profile is a model class plus an effort level: `<class>-<effort>`.

| Class | Meaning |
| --- | --- |
| `small` | The cheapest model that reliably follows instructions and runs tools |
| `standard` | The default coding model |
| `frontier` | The most capable model available |

Effort is `low`, `medium` or `high`, mapped to the agent CLI's own setting (thinking budget or reasoning effort).

**The plan recommends, the operator dispatches, the orchestrator maps.**

1. The planning agent gives each issue a profile in the plan, from the default table in `standards/wave-planning.md`. It goes on the issue as a `run:<class>-<effort>` label.
2. The coordinator snapshots the profile when the operator adds `agent:ready`, with the dependencies and area (ADR-005). An agent editing the label later changes nothing. An issue with no profile runs as `standard-medium`.
3. The orchestrator maps each class to a concrete model and CLI in `RUN_PROFILES`, a Worker variable the operator sets with `wrangler`. Each profile in it also sets the run's token budget and wall-clock limit. The agent holds no Cloudflare credential, so it can't change the map.

**One automatic escalation.** A run that ends failed, or hits its token budget with acceptance still failing, is restarted once at the next class up, same effort, from its branch and handoff note. Only if `AUTO_ESCALATE` is on (default on) and the daily budget allows. A second failure is handled as blocked. `frontier` doesn't escalate. Escalations are counted per profile in the run metrics.

**The PR audit uses profiles too.** The reviewer's profile follows the PR's tier: `standard-low` for tier 1, `frontier-high` for tier 2 and 3, and for release PRs. The security reviewer is always a different model family than the builder (spec 0001, Merge gate). So is the readiness review of plan PRs.

**The retrospective calibrates the table.** The run metrics record, per profile: cost per merged PR including rework (resumes, escalations, catch-ups, audit rejections), first-pass rate, and approver send-backs. `/retro` proposes changes to the default table through a PR. Nothing changes the table automatically.

## Alternatives considered

- **One model for everything, tuned by budget only.** Simple, but it either overpays on easy issues or underpowers hard ones, and the budget can't fix the second case.
- **The agent picks its own model or effort.** It knows the most about the task once started, but it would be choosing its own spend. Its choice can't be a control.
- **A router that classifies each issue at run time.** A cheap model reads the issue and picks a profile. It may be more accurate later, but it's an LLM decision with no human checkpoint, and the planning agent already reads every issue closely. Revisit when the retro data shows the plan's guesses are poor.
- **Name concrete models in plans.** Readable, but it couples every plan to a vendor and goes stale on every model release.
- **Automatic escalation without a limit.** It raises the success rate, but one bad issue could climb to `frontier-high` and retry until the daily budget runs out. One step up keeps the worst case at two runs.

## Consequences

- Cost becomes something the plan decides per issue and the retro measures, instead of one global number.
- The worst-case spend per issue is the budget of its profile plus the budget of the next class up.
- The orchestrator needs `RUN_PROFILES` and `AUTO_ESCALATE`, and bootstrap needs to create the nine `run:*` labels.
- The default table in `wave-planning.md` is a guess until two or three waves of metrics exist.
- Spec 0001's open decision on builder and reviewer models narrows to filling in `RUN_PROFILES`.
