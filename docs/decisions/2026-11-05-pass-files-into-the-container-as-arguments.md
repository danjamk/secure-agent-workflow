### 2026-11-05 Pass files into the container as arguments

- **Decision:** The Worker writes each file by passing its content as a base64 argument to `sh`, which decodes it to the path. The issue body is cut at 60,000 characters.
- **Why:** Nothing in the content reaches a shell as code. An argument is capped at 128 KiB on Linux, and the cut keeps the issue under it.
- **Rejected:** Streaming the content on stdin, which I couldn't test without the platform.
- **Decided by:** Claude
- **Approved by:** None
- **Evidence:** `writeFile` in `orchestrator/src/run.ts`
