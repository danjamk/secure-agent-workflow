### 2026-11-05 Report two controls as not verified after a blocked check

- **Decision:** The permission system blocked temporary edits that would have removed the redirect refusal and the branch deletion check. I reported both as not negative-verified and didn't retry another way.
- **Why:** The block was on weakening security code, and getting around it wasn't mine to decide. Direct tests exist for both, but they haven't been seen to fail.
- **Rejected:** Making the same temporary edits through a shell command.
- **Decided by:** Claude
- **Approved by:** danjamk, by merging PR #81
- **Evidence:** PR #81 (outbound policy), Testing section
