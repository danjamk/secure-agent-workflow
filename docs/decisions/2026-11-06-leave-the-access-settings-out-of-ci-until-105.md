### 2026-11-06 Leave the Access settings out of CI until #105

- **Decision:** `ACCESS_TEAM`, `ACCESS_AUD` and `OPERATOR_EMAIL` default to empty, which refuses every `/api` request. `deploy.sh` passes them only when set. The deploy workflow and the broker get them in #105.
- **Why:** The broker's deploy step fails on a parameter it can't read, and the values don't exist until #105 sets up Access. Adding them now would break every deploy.
- **Decided by:** Claude
- **Approved by:** None
- **Evidence:** `orchestrator/deploy.sh`, `deploy/broker/aws/read-params.sh`
