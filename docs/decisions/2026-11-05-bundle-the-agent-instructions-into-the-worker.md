### 2026-11-05 Bundle the agent instructions into the Worker

- **Decision:** A wrangler Text rule bundles `standards/agent-instructions.md` into the Worker, which writes it into each container. That reaches across folders, so it's named in the orchestrator's contract.
- **Why:** The standards README says the orchestrator puts the instructions in the sandbox. Bundling means a run always gets the instructions from the deployed commit.
- **Rejected:** Copying them into the image, which Docker can't do from outside the `container/` build folder. Fetching them at run time, which adds a call that can fail.
- **Decided by:** Claude
- **Approved by:** None
- **Evidence:** `orchestrator/wrangler.jsonc`, `orchestrator/src/agents/claude-code.ts`
