### 2026-11-05 Intercept only listed hosts

- **Decision:** A run intercepts HTTPS for GitHub, the model hosts and the repo's registries by name, with no `*` and no plain HTTP. This replaces the #8 plan to intercept all HTTP and HTTPS.
- **Why:** With `*`, every hostname resolves, so DNS could carry data out and #79's DNS check couldn't pass. The cost is that a request to an unlisted host fails inside the container and isn't logged.
- **Rejected:** Intercepting everything, which logs every attempt with a reason.
- **Decided by:** Claude proposed, danjamk chose
- **Approved by:** danjamk, replied "approved. Proceed" in the working session
- **Evidence:** PR for #79 (container proof), `orchestrator/src/sandbox.ts`
