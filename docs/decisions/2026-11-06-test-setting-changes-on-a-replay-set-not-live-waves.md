### 2026-11-06 Test setting changes on a replay set, not live waves

- **Decision:** Spec 0003 proposes that a change to instructions, skills or model settings is tested by replaying 10 to 20 past issues, paired by issue, before it's adopted.
- **Why:** Live waves are a few dozen runs on different issues, too few and too varied to tell a real change from noise.
- **Rejected:** Comparing live waves before and after the change.
- **Decided by:** Claude proposed; danjamk asked for the spec ("Go")
- **Approved by:** None
- **Evidence:** `docs/specs/0003-factory-metrics.md`
