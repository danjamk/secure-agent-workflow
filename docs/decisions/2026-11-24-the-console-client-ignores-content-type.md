### 2026-11-24 The console client ignores Content-Type

- **Decision:** The console's data client (W1-1) parses every response body as JSON and validates its shape, whatever the `Content-Type` header says.
- **Why:** On a local host, `tailscale serve` sends the snapshot files as `text/plain`, because it guesses the type from the content. The shape check already rejects anything malformed, so the header adds nothing.
- **Rejected:** A small server on the local host to set `application/json`, which would be one more process next to the dispatcher's state.
- **Decided by:** Claude proposed, danjamk chose
- **Approved by:** None
- **Evidence:** ADR-012 (revised), `docs/plans/console-phase-1.md` (W1-1), a live check of a local host's feed on 2026-11-24
