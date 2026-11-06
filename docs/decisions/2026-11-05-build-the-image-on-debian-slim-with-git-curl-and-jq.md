### 2026-11-05 Build the image on Debian slim with git, curl and jq

- **Decision:** The image is `debian:trixie-slim` pinned by digest, with `ca-certificates`, `curl`, `git` and `jq`. The proposal named only `git` and `curl`.
- **Why:** `jq` lets the probe build and read JSON safely, instead of by string matching. Debian's packages aren't pinned, so a rebuild picks up security updates.
- **Decided by:** Claude
- **Approved by:** None
- **Evidence:** `orchestrator/container/Dockerfile`
