### 2026-11-05 Make the probe open a PR and aim its denials at fake ids

- **Decision:** Besides cloning and pushing, the probe opens a draft PR, marks it ready and comments on the issue. Checks that should be denied target the testbed or fake ids. Each run leaves a branch, a PR and a comment on the testbed.
- **Why:** #9 (agent CLI in a sandbox) depends on the PR path. If a filter fails, GitHub returns an error instead of changing anything.
- **Rejected:** Only clone and push, as #79 first said.
- **Decided by:** Claude proposed, danjamk chose
- **Approved by:** danjamk, replied "approved. Proceed" in the working session
- **Evidence:** PR for #79 (container proof), `orchestrator/container/probe.sh`
