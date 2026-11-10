### 2026-11-10 Run a catch-up as a pinned resume with fixed instructions

- **Decision:** A catch-up is a queue entry ahead of new issues that runs Claude Code on the PR's branch, with the branch and PR pinned. `run-agent.sh` gives it fixed text: merge the default branch in, never rebase or force-push, resolve the conflicts, run `make check`, push and comment. It doesn't use up one of the release's 3 runs.
- **Why:** The outbound policy already allows exactly that: one push to the pinned branch and a comment on the pinned PR. Fixed text keeps the instruction out of anything an issue or PR can change.
- **Decided by:** Claude proposed, danjamk chose
- **Approved by:** danjamk, replied "approved" in the working session
- **Evidence:** `orchestrator/src/coordinator.ts` (`queueCatchUps`), `orchestrator/container/run-agent.sh`
