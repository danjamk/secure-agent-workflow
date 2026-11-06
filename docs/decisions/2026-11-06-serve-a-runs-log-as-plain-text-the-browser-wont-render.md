### 2026-11-06 Serve a run's log as plain text the browser won't render

- **Decision:** The log route returns `text/plain` with `nosniff`, `Content-Security-Policy: default-src 'none'` and `Cache-Control: no-store`.
- **Why:** A log holds whatever the agent printed, including HTML, so it's untrusted. The browser shows it as text and keeps no copy.
- **Decided by:** Claude
- **Approved by:** None
- **Evidence:** `orchestrator/src/api.ts`
