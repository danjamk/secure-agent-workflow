### 2026-11-10 Fix the resume note's stray dollar sign

- **Decision:** The resume note in `run-agent.sh` no longer has a stray `\$` and line break before the reply's path.
- **Why:** A resumed agent was told to read the reply "in $" followed by the path on the next line.
- **Decided by:** Claude
- **Approved by:** None
- **Evidence:** `orchestrator/container/run-agent.sh`
