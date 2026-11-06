### 2026-11-06 Turn off Claude Code's commit trailer in managed settings

- **Decision:** The image writes `/etc/claude-code/managed-settings.json` with `{"attribution": {"commit": ""}}`, read-only. The PR line Claude Code adds stays.
- **Why:** An agent commit carried a `Co-Authored-By` trailer, against the standard. Managed settings outrank the repo's own `.claude/settings.json`. That `""` hides the trailer comes from the settings reference's summary, not a tested example, so the next agent run checks it.
- **Rejected:** The deprecated `includeCoAuthoredBy: false`, which may also drop the PR line.
- **Decided by:** Claude
- **Approved by:** danjamk, "go" to the fix list in the working session
- **Evidence:** `orchestrator/container/Dockerfile`
