### 2026-11-05 List the headers that leave the sandbox

- **Decision:** The handler forwards only listed request headers. It drops `Accept-Encoding` and leaves compression to the Workers runtime.
- **Why:** A list keeps out `Authorization`, `Cookie`, `Proxy-*` and `X-HTTP-Method-Override` without naming each one. Dropping `Accept-Encoding` avoids decoding a response twice, which is inference from the runtime's behavior and hasn't been tested live.
- **Rejected:** Removing a list of known bad headers, which misses any header not on it.
- **Decided by:** Claude
- **Approved by:** None. PR #81 (outbound policy) merged, but its description didn't list this
- **Evidence:** `orchestrator/src/outbound/handler.ts`
