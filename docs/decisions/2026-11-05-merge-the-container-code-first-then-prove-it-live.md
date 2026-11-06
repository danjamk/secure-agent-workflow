### 2026-11-05 Merge the container code first, then prove it live

- **Decision:** The container code merges with `Refs #79`, the CI deploy builds the image, and a later docs PR records the live probe and closes #79. The deploy tries the current token first, so the docs record the permissions it actually needs.
- **Why:** Deploys run only from `main`, which is the same pattern as #75 (CI deploy). No document states the token permissions.
- **Rejected:** Deploying a branch by hand, which skips review and the approval step.
- **Decided by:** Claude proposed, danjamk chose
- **Approved by:** danjamk, replied "approved. Proceed" in the working session
- **Evidence:** PR for #79 (container proof)
