# ADR-004: Build agents run in the Cloudflare Sandbox SDK

Status: Accepted · Date: 2026-10-30

## Context

Build agents need an isolated environment with deny-by-default egress and no credentials inside. The platform must be neutral on agent CLI and model vendor, because clients may not allow a given vendor and the workflow should mix vendors. Full comparison: [sandbox bake-off](../research/sandbox-bakeoff.md).

## Decision

An orchestrator Worker starts a Cloudflare Sandbox SDK microVM per issue. `enableInternet = false` plus `allowedHosts` sets egress. Worker outbound handlers inject the GitHub App token and model API keys per request and reject pushes outside `agent/*`. The planning agent, where Dan is in the loop, uses Claude directly.

## Alternatives considered

- **Claude Code cloud sessions.** Every control built in at no extra cost, but tied to one vendor, and the session acts as Dan's GitHub identity.
- **GitHub Actions runner with Harden-Runner.** Free on public repos; egress blocking is paid on private repos, and model keys sit on the runner.
- **E2B.** Vendor-neutral with Firecracker and egress control; less to build. The fallback if the orchestrator stalls.
- **Local Docker Sandboxes.** Same security model and free, but needs Dan's machine on.

## Consequences

- About $5–7 a month on Workers Paid.
- The orchestrator, token minting and push filter are code this repo owns.
- Only HTTP and HTTPS on ports 80 and 443 reach the handlers, so git runs over HTTPS.
