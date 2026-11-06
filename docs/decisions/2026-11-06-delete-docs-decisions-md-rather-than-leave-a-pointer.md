### 2026-11-06 Delete docs/decisions.md rather than leave a pointer

- **Decision:** The old single file is deleted. `docs/decisions/README.md` explains the folder and that git history keeps the old file.
- **Why:** A file at the old path, even a one-line pointer, invites a person or an agent to add entries to it, which brings the conflicts back.
- **Rejected:** A one-line pointer, which would keep old links working.
- **Decided by:** Claude
- **Approved by:** None
- **Evidence:** #94 (one file per decision)
