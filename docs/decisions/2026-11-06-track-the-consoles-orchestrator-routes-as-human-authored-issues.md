### 2026-11-06 Track the console's orchestrator routes as human-authored issues

- **Decision:** The console's workspace, deploy and orchestrator routes are four issues (H-1 to H-4 in `docs/plans/console-phase-1.md`), authored by the operator, sub-issues of #35 with no milestone.
- **Why:** They are code with tests and a review, like #9 to #13, and the epic should show what blocks the console. They stay out of the wave milestone because `/dispatch` labels every open issue in a milestone and tier 3 work stays out of waves.
- **Rejected:** Operator tasks at the top of the wave, as the draft had them, which leaves the largest pieces of Phase 1 untracked.
- **Decided by:** Claude proposed; danjamk leaned toward issues in the handoff
- **Approved by:** None
- **Evidence:** `docs/plans/console-phase-1.md`, `standards/wave-planning.md`, `standards/skills/dispatch/SKILL.md`
