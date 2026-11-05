# Console

The operator console (spec 0002): a Cloudflare Worker in the factory account, behind Cloudflare Access, that shows what's waiting on the operator, what's running, and spend, and lets the operator stop a run. Not built yet; `design/` holds the approved design, and `docs/plans/console-phase-1.md` the build plan.

## Contracts with other components

| Component | What the console expects |
| --- | --- |
| `orchestrator/` | Read routes for run records, the coordinator's queue and daily spend, and a stop route (spec 0002, Stop). All behind the same Cloudflare Access policy as the console. The console never talks to a sandbox |
| GitHub | Read-only, through the orchestrator: blocked issues and their handoff notes, PRs waiting on approval, check runs. Every action other than Stop is a link out to GitHub |
| Cloudflare Access | The operator's identity. The console shows it and passes it to the stop route |

The console holds no credential the orchestrator doesn't already hold (spec 0001).

## Other options for a fork

| Option | Trade-off |
| --- | --- |
| No console: GitHub notifications and the Slack digest only | Nothing to build or host, but no one place shows spend or what's running |
| A GitHub Projects board fed by labels | Familiar and free, but no live run state, cost or Stop |
