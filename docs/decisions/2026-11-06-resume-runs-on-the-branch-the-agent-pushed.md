### 2026-11-06 Resume runs on the branch the agent pushed

- **Decision:** A resumed run's script fetches the saved branch and checks it out before Claude Code starts. The prompt says it's a resumed run and points at the reply.
- **Why:** The new container starts empty, and the branch is where the earlier work is.
- **Decided by:** Claude
- **Approved by:** None
- **Evidence:** `orchestrator/container/run-agent.sh`
