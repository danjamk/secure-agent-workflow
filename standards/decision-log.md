# Decision log

Each repo keeps one log at `docs/decisions.md`: a plain record of what was decided, why, who decided and who approved it. It's written for someone who wasn't there, such as an independent reviewer, the PR audit or the operator six months later.

The log is a record. It isn't a control, so it never grants an approval. What lets a change merge is the tier check.

## What goes in

Log a decision when all of these hold:

- There was a real alternative that someone could reasonably have chosen.
- It changes behavior, security, cost, scope or an earlier decision.
- A reader couldn't work out the reason from the diff.

Leave out naming, formatting and refactors with no change in behavior. Skip anything the issue already specified, unless the work departs from it.

An ADR records a decision that's expensive to reverse or sets a rule for the whole system. Give that decision a one-entry pointer here, linking the ADR, so the log stays the complete list. Other decisions need only the entry.

## Format

Add new entries at the bottom, in the same PR as the work.

```markdown
### 2026-11-05 Block force-pushes with a ruleset

- **Decision:** A GitHub ruleset on `agent/**` rejects non-fast-forward updates.
- **Why:** A push's ref commands can't show a force-push. That takes the commit graph.
- **Rejected:** Parsing the pack in the Worker.
- **Decided by:** Claude
- **Approved by:** danjamk, replied "approved" in the working session
- **Evidence:** PR #81 (outbound policy), #8 (outbound handlers)
```

| Field | Rule |
| --- | --- |
| **Decision** | One or two sentences, stated plainly |
| **Why** | The reason, in at most three sentences |
| **Rejected** | The main alternative and why not. Write "None considered" if that's true |
| **Decided by** | Who made the call: a person's login, or the agent. When a person chooses from a recommendation, name who proposed it, such as "Claude proposed, danjamk chose" |
| **Approved by** | See below |
| **Evidence** | The PR, plus any issue, ADR or test that backs it up |

## Approved by

Use the entry that's true:

| Value | When |
| --- | --- |
| `<login>, replied "<words>" in the working session` | A person told an assistant to go ahead. The assistant wrote this line, so it's a claim until that person merges the PR containing it |
| `<login>, by merging PR #N` | Nobody was asked directly, and the person accepted the decision by merging a PR that listed it |
| `<login>, by approving PR #N` | The approver reviewed an agent's PR |
| `None` | Nobody reviewed it, such as in a tier 1 PR that merged on green |

**Build agents always write `None`.** An agent can't approve its own decision, and it can't know who will. If an approver later reviews the PR, the PR's review history is the record, and the approver can change the line in that PR.

To check a claim, look at who merged or approved the linked PR. Git and GitHub hold that history, and an entry doesn't override it.

## Changing a decision

Don't edit or delete an old entry. Add a new one that says which entry it replaces, by date and title. Correcting a typo or a broken link is fine.

## What not to put in it

The log follows the repo's visibility, and in a public repo everyone can read it. Leave out credentials, account IDs, client names and anything else the repo's rules keep private.

## Other options for a fork

| Option | Trade-off |
| --- | --- |
| One file per decision in `docs/decisions/` | No merge conflicts when agents run in parallel, but it's harder to read through |
| Decisions in PR descriptions only | Nothing to maintain, but there's no single list, and the record lives only on GitHub |
| ADRs for everything | Fuller reasoning, but too heavy for the many small calls an agent makes, so they'd go unrecorded |
