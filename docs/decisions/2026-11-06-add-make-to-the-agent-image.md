### 2026-11-06 Add make to the agent image

- **Decision:** The image installs `make`.
- **Why:** The agent instructions say to run `make check`, and the first agent run couldn't. The agent reported it in its run notes.
- **Decided by:** Claude
- **Approved by:** None
- **Evidence:** agent-testbed PR #39, run notes
