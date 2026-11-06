### 2026-11-06 Put console/deploy.sh at tier 3 and leave the console's other tiers to the operator

- **Decision:** `console/deploy.sh` is tier 3, because it runs with the factory deploy token. The rest of `console/` stays at the default tier 2. The console plan's operator task 1, which makes console code tier 1, isn't done here.
- **Why:** Choosing which console code agents may merge unreviewed is the operator's call, and the plan lists it as their task.
- **Decided by:** Claude
- **Approved by:** None
- **Evidence:** `.github/self-tier-map.yml`, `docs/plans/console-phase-1.md` (operator tasks)
