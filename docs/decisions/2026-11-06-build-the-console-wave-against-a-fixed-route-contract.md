### 2026-11-06 Build the console wave against a fixed route contract

- **Decision:** The plan fixes the orchestrator's console routes as TypeScript types, and every console issue tests against fixtures of them, so the wave can run before #13 and workflow-loop W1-4 land.
- **Why:** The console's real data depends on most of build order step 1. Fixtures let the screens and Stop be built and reviewed in parallel with that work.
- **Decided by:** Claude
- **Approved by:** None
- **Evidence:** `docs/plans/console-phase-1.md`, Route contract
