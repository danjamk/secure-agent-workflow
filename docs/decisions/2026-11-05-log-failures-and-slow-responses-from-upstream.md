### 2026-11-05 Log failures and slow responses from upstream

- **Decision:** The outbound handler logs the host, method, status and time of any upstream response that's a 5xx or takes over 5 seconds, with no path or body.
- **Why:** The platform's log shows only what the handler returned, so the first probe's 502 couldn't be traced to upstream or to the Worker.
- **Decided by:** Claude
- **Approved by:** None
- **Evidence:** `send` in `orchestrator/src/outbound/handler.ts`
