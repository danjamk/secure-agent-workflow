### 2026-11-06 Serve the console's placeholder page with no build step

- **Decision:** The console serves `public/` as static files, with a one-line placeholder page. There's no build step yet. `happy-dom` is installed now, as the console plan asks, so the console wave doesn't need to change the lockfile.
- **Why:** The screens are the wave's work (W1-1 adds the shell). The lockfile is tier 3, which agents can't merge.
- **Decided by:** Claude
- **Approved by:** None
- **Evidence:** `console/package.json`, `console/public/`, `docs/plans/console-phase-1.md` (H-1)
