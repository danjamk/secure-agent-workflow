### 2026-11-05 Post one status comment per run

- **Decision:** The orchestrator posts a comment when a run starts and edits it when the run ends. There's no running label and no board move.
- **Why:** The issue showed nothing between release and the agent's first push. ADR-005 keeps run state out of labels, and the App can't write to a user-owned project.
- **Rejected:** An `agent:running` label, and a new comment for each event.
- **Decided by:** Claude proposed, danjamk chose
- **Approved by:** danjamk, replied "Add it" in the working session
- **Evidence:** [#9 comment](https://github.com/danjamk/secure-agent-workflow/issues/9#issuecomment-6672945291)
