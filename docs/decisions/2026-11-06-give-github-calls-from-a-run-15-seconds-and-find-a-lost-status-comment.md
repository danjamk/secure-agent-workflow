### 2026-11-06 Give GitHub calls from a run 15 seconds, and find a lost status comment

- **Decision:** The limit on the orchestrator's GitHub calls goes from 3 to 15 seconds. A run that ends without its start comment's id finds that comment by the run id and edits it.
- **Why:** The first agent run posted its result as a second comment. The 3-second limit dates from when the webhook made these calls under GitHub's 10-second limit, and runs now make them from an alarm. The cause isn't confirmed, so the run also recovers on its own.
- **Rejected:** Posting a second comment, which is what happened.
- **Decided by:** Claude
- **Approved by:** None
- **Evidence:** agent-testbed #38, `orchestrator/src/github.ts`
