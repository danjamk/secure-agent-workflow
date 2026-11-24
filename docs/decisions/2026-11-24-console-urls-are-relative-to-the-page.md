### 2026-11-24 Console URLs are relative to the page

- **Decision:** The console frontend uses page-relative URLs (`api/waiting`, `app.js`), never a leading `/`. A local host with several sources serves each under its own path, such as `/<source>/`, and the MCP server takes one base URL per source.
- **Why:** The operator wants one console on a local host covering every source it runs, each with its own spend cap and slots. Page-relative URLs let one build serve at any path; root-relative ones would need a rework after the wave.
- **Rejected:** One merged feed across sources, which would mix separate spend caps and slots into one Factory view.
- **Decided by:** Claude proposed, danjamk chose
- **Approved by:** None
- **Evidence:** ADR-012 (revised), `docs/plans/console-phase-1.md` (W1-1, W1-8)
