### 2026-11-06 Don't render the decisions in the Pages site

- **Decision:** The GitHub Pages site doesn't get a combined decisions page. `make decisions` and the folder listing are the ways to read them.
- **Why:** `docs/` is served as it is, with no build step. Rendering the log would need a new workflow, and workflows here are control code.
- **Decided by:** Claude
- **Approved by:** None
- **Evidence:** #94 (one file per decision), `.github/workflows/`
