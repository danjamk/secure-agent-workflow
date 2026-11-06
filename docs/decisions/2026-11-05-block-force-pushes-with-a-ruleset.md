### 2026-11-05 Block force-pushes with a ruleset

- **Decision:** A GitHub ruleset on `agent/**`, applied by bootstrap, rejects non-fast-forward updates. The push filter checks ref names and deletions.
- **Why:** A push's ref commands can't show a force-push. That takes the commit graph, and the new objects aren't on GitHub yet.
- **Rejected:** Parsing the pack in the Worker, which is more code to get wrong and duplicates what GitHub enforces.
- **Decided by:** Claude proposed, danjamk chose
- **Approved by:** danjamk, replied "approved" in the working session
- **Evidence:** PR #81 (outbound policy), `bootstrap/README.md`. Live proof is in #79 (container proof)
