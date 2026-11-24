# ADR-012: The console reads from one of two feeds: the orchestrator, or files on a local host

Status: Proposed · Date: 2026-11-24 · Revised: 2026-11-24 (page-relative URLs, one path per source) · Amends: [ADR-010](ADR-010-console-stop-route.md) (topology), spec 0002 (hard constraints 6 and 9)

## Context

The console (spec 0002) is a static frontend that reads `/api/*` routes in the plan's route contract (`docs/plans/console-phase-1.md`). ADR-010 serves it from the factory account, behind Cloudflare Access, with the orchestrator answering `/api/*`.

Two hosts need the same screens without the factory account:

- **ADR-011's `local` host.** Runs on the operator's own machine, reached over a tailnet. Its run records are in SQLite on that machine, not in the orchestrator.
- **A consumer's own dispatcher.** A consumer project's operator runs a simpler dispatcher on the same machine today, and wants to see what it's doing from a phone. Pushing its state to Cloudflare would put a factory-account write credential on a machine where agents run, which spec 0001 rules out.

The operator also wants the same data in Claude on a laptop, through an MCP server.

## Decision

**The console is one frontend with two feeds.** The frontend never knows which one it's reading.

| | Orchestrator feed | Snapshot feed |
| --- | --- | --- |
| Where | Factory account (ADR-010) | A local host, on the operator's tailnet |
| Front door | Cloudflare Access | `tailscale serve`, with Funnel off; the tailnet policy allows only the operator |
| `/api/*` | The orchestrator, which verifies the Access JWT on every request | Static JSON files the host's dispatcher writes on every pass, one per read route. A host with several sources (one dispatcher per account, or a dispatcher and ADR-011's `local` host) serves each under its own path, such as `/<source>/api/waiting` |
| Operator identity | The Access identity | The tailnet login; `operator` in each file is the configured operator |
| Stop | ADR-010's route | Not in Phase 1. `stopAvailable: false`, and the frontend hides Stop |
| Frontend | Deployed by `console-deploy.yml` | A published static build, installed at a pinned version and SHA-256 |

**Rules for the frontend,** so both feeds work:

- Every request and asset URL is relative to the page: `api/waiting` and `app.js`, never `/api/waiting` or a hostname. The same build then works at `/` behind Access and at `/<source>/` on a local host. A page opened without its trailing slash (`/<source>`) would resolve `api/waiting` to `/api/waiting`, so the host redirects to `/<source>/`.
- Nothing in the frontend depends on Cloudflare: no Access cookie handling, no Worker-only behavior. The Worker stays a pass-through.
- A response can be stale without a failed request: a stopped dispatcher leaves its last files in place. The feed counts as lost when `generatedAt` is older than 3 minutes, as well as after 30 seconds without a successful fetch.
- Stop renders only when `factory.stopAvailable` is true.
- The client parses the body and validates its shape; it never relies on `Content-Type`. `tailscale serve` sends the snapshot files as `text/plain`, because it guesses the type from the content.

**The route contract gains three fields** that both feeds fill: `factory.pause` (why nothing new starts: spend, operator or usage limit), `factory.queue` (each waiting issue with its wait reasons, which spec 0002 defines but the contract left out) and `factory.stopAvailable`.

**The MCP server is a third reader of the same routes.** `console/mcp/` is a stdio server the operator runs on a laptop. It imports the frontend's typed client (`src/api.ts`), takes one or more base URLs (one per source, path included), and has read-only tools: `waiting`, `runs`, `spend` and `why_idle`. On a snapshot feed it needs no credential: the laptop's tailnet login is the access control. On the orchestrator feed it needs an Access token, which is left for a later issue.

## Alternatives considered

- **Push the local host's state to a Worker and KV in the factory account.** One console for everything. It lost because the local machine would hold a factory-account write credential where agents run (spec 0001), Stop still couldn't reach a machine that accepts no inbound traffic, and a consumer's state would sit in the factory account.
- **Host the local console in the consumer's dev target.** No new account. It lost because agents hold that account's deploy token, so an agent could replace the console and show the operator false status.
- **A separate console for local hosts.** No contract to share. It lost because two frontends would drift, and ADR-011 commits to one set of controls across hosts; the console should follow.
- **A server process on the local host instead of static files.** It could read the operator's tailnet identity from `tailscale serve`'s headers and could later serve Stop. It lost for Phase 1 because it is one more process with access to the dispatcher's state, for no read-only gain. It is the path for Stop on a local host, with its own ADR.
- **An MCP server over SSH to the local host.** Works before any console exists. It lost because it gives the laptop's Claude a shell in the account that runs agents. The HTTP routes are read-only by construction.

## Consequences

- The route contract has a second producer. A contract change now needs both feeds updated, so the contract moves from the plan into `console/src/api.ts` as the single typed source, with the plan pointing at it.
- The console needs a published static build for local hosts (H-6) and an MCP dependency (H-5). Both change tier 3 paths, so they are human-authored.
- Spec 0002 hard constraint 6 becomes "the operator is the front door's identity", and constraint 9 covers the snapshot feed, which holds no credential at all.
- A local host's tailnet policy becomes part of the console's security. A policy that lets other tailnet users reach the host lets them read the console. The host's own setup records that policy.
