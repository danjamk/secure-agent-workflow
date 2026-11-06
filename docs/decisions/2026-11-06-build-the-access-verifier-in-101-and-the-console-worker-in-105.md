### 2026-11-06 Build the Access verifier in #101 and the console Worker in #105

- **Decision:** #101 builds the orchestrator's Access verifier and the log route. The console Worker, its deploy, the log links and the operator's setup are #105, which is the console plan's H-1. H-2 keeps only the waiting route.
- **Why:** Serving logs needs the verifier, and the verifier is the same one the console needs. The console Worker needs its own workspace, gate and deploy, which would push #101 past two days.
- **Decided by:** Claude proposed, danjamk chose
- **Approved by:** danjamk, replied "approved" in the working session
- **Evidence:** #101, #105, `docs/plans/console-phase-1.md`
