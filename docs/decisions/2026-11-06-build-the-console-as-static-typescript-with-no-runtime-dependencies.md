### 2026-11-06 Build the console as static TypeScript with no runtime dependencies

- **Decision:** The console is TypeScript compiled by `tsc` to ES modules and served as static assets, with no framework and no bundler. Dev dependencies are installed once, in H-1.
- **Why:** The lockfile is tier 3 in this repo, so agents can't add dependencies, and the design is plain CSS classes that need no framework.
- **Rejected:** A UI framework with a bundler, which would need dependency changes during the wave.
- **Decided by:** Claude
- **Approved by:** None
- **Evidence:** `docs/plans/console-phase-1.md`, H-1; `.github/self-tier-map.yml`
