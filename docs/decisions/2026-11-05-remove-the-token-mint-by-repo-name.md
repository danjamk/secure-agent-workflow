### 2026-11-05 Remove the token mint by repo name

- **Decision:** `mintInstallationToken`, which limited a token by repo name, is gone. Runs use `mintRunToken`, which limits it by repo id.
- **Why:** Nothing calls it once releases start runs, and a leftover helper looks like the right one to use.
- **Decided by:** Claude
- **Approved by:** None
- **Evidence:** `orchestrator/src/github.ts`
