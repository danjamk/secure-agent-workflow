### 2026-11-05 Keep the probe as a second runner, picked by agent:probe

- **Decision:** CLI-specific code lives in `src/agents/`. The probe stays as a second runner, picked when an issue also has `agent:probe`, which bootstrap now creates.
- **Why:** Two runners show that adding a CLI touches one module. Keeping the probe lets anyone recheck the policy after a change.
- **Rejected:** Dropping the probe now that the agent runs.
- **Decided by:** Claude proposed, danjamk chose
- **Approved by:** danjamk, replied "approved" in the working session
- **Evidence:** `orchestrator/src/agents/`
