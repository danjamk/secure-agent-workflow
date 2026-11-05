# ADR-004: Build agents run in Cloudflare containers

Status: Accepted · Date: 2026-10-30 · Revised: 2026-11-05 for Sandbox SDK 1.0 (#8)

## Context

Build agents need an isolated environment with deny-by-default egress and no credentials inside. The platform must be neutral on agent CLI and model vendor, because clients may not allow a given vendor and the workflow should mix vendors. Full comparison: [sandbox bake-off](../research/sandbox-bakeoff.md).

## Decision

An orchestrator Worker starts a Cloudflare container per issue, through a Durable Object. It starts with `enableInternet: false`, so only requests our handler intercepts leave it. An `Outbound` entrypoint in the Worker receives all of the container's HTTP and HTTPS, applies the policy in `orchestrator/src/outbound/`, and adds the GitHub App token and model API keys per request. The planning agent, where Dan is in the loop, uses Claude directly.

Sandbox SDK 1.0 moved outbound control to the platform's `ctx.container` API and replaced the SDK's `allowedHosts`, so this needs no SDK dependency. `@cloudflare/sandbox` now adds only file helpers, and #9 can add it if the runner needs them.

## Alternatives considered

- **Claude Code cloud sessions.** Every control built in at no extra cost, but tied to one vendor, and the session acts as Dan's GitHub identity.
- **GitHub Actions runner with Harden-Runner.** Free on public repos; egress blocking is paid on private repos, and model keys sit on the runner.
- **E2B.** Vendor-neutral with Firecracker and egress control; less to build. The fallback if the orchestrator stalls.
- **Local Docker Sandboxes.** Same security model and free, but needs Dan's machine on.

## Consequences

- About $5–7 a month on Workers Paid.
- The orchestrator, token minting and push filter are code this repo owns.
- Only HTTP and HTTPS reach the handler, so git runs over HTTPS. The handler refuses plain HTTP, so a credential is never added to it.
- Every process in a container has root's Linux capabilities, whatever user it runs as, so nothing inside the container can act as a control.
- `wrangler deploy` needs Docker for the image. The Durable Object scheduling policy for containers is in public beta.
- The handler sees requests, not the commit graph, so a GitHub ruleset blocks force-pushes on `agent/**`.
