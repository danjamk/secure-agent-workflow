### 2026-11-05 Run Claude Code headless with prompts off and vendor-run tools off

- **Decision:** Claude Code runs with `-p`, stream-json output to a file, `--dangerously-skip-permissions` as a non-root `agent` user, 200 turns, a $5 estimate, and web search and web fetch turned off. Telemetry, error reports, auto-update and feedback are off. The main model is `claude-sonnet-5-5`, and background work uses `claude-haiku-5-5`.
- **Why:** The container is the control, so prompts would only stall the run. Claude Code refuses to skip prompts as root. Each turned-off feature would try a host the container can't reach.
- **Decided by:** Claude proposed, danjamk chose
- **Approved by:** danjamk, replied "approved" in the working session
- **Evidence:** `orchestrator/src/agents/claude-code.ts`, `orchestrator/container/run-agent.sh`
