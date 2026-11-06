### 2026-11-06 Copy Access's cookie into the token header when the header is missing

- **Decision:** The console forwards `Cf-Access-Jwt-Assertion` as Access sent it. If it's missing, the console copies the token from Access's `CF_Authorization` cookie. Cookies themselves aren't forwarded.
- **Why:** Cloudflare's docs imply the header but don't say it reaches a Worker protected at the Worker level. The cookie holds the same signed token, and the orchestrator verifies it either way.
- **Decided by:** Claude proposed, danjamk chose
- **Approved by:** danjamk, replied "approved" in the working session
- **Evidence:** `console/src/worker.ts`, `console/test/worker.test.ts`
