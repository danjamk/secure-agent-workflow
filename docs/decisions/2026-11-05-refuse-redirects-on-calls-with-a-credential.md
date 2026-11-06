### 2026-11-05 Refuse redirects on calls with a credential

- **Decision:** The handler never follows a redirect, and it returns a 502 for one from a call that carried a credential.
- **Why:** A `Location` can hold a signed URL, such as for a tarball, and returning it would give the sandbox a credential.
- **Rejected:** Passing redirects back to the client, which is what the handler does for registries, because those calls carry no credential.
- **Decided by:** Claude
- **Approved by:** danjamk, by merging PR #81
- **Evidence:** PR #81 (outbound policy) notes that the test for this wasn't negative-verified
