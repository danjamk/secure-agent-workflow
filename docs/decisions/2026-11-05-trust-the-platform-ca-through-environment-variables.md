### 2026-11-05 Trust the platform CA through environment variables

- **Decision:** The probe gets `GIT_SSL_CAINFO`, `CURL_CA_BUNDLE`, `SSL_CERT_FILE` and `NODE_EXTRA_CA_CERTS`, all pointing at the platform's CA. The system trust store isn't changed.
- **Why:** Every HTTPS request is intercepted, so that CA is the only one needed. This needs no step that writes to the trust store at startup.
- **Rejected:** Merging the CA into the system bundle, which Cloudflare's docs also describe.
- **Decided by:** Claude
- **Approved by:** None
- **Evidence:** `probeEnv` in `orchestrator/src/sandbox.ts`
