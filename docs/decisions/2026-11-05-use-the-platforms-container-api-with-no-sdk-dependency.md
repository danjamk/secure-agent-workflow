### 2026-11-05 Use the platform's container API, with no SDK dependency

- **Decision:** The orchestrator starts containers through `ctx.container` and handles outbound traffic in its own `Outbound` entrypoint. It doesn't depend on `@cloudflare/sandbox`.
- **Why:** Sandbox SDK 1.0 moved outbound control to the platform and removed the `allowedHosts` API that ADR-004 and #8 named. The package now adds only file helpers.
- **Rejected:** Pinning SDK 0.x to keep the API the issue named, because it's replaced.
- **Decided by:** Claude proposed, danjamk chose
- **Approved by:** danjamk, replied "approved" in the working session
- **Evidence:** PR #81 (outbound policy), [#8 design comment](https://github.com/danjamk/secure-agent-workflow/issues/8#issuecomment-6657191929), ADR-004
