# Data change patterns

How to change schemas and stored data so every release can be rolled back (ADR-008). The planning agent uses this when it designs a feature and writes the plan. Build agents follow it when an issue changes persisted data. `/release-prep` reads the steps it declares.

The rule: **the previous release's code must run correctly against the data the new release writes.** Everything below is a way to keep that true.

## Decide at design time

Rollback risk is set when the feature is designed, not when it ships. When a spec or plan touches persisted data, answer these before writing issues:

1. **What does the old code read?** Every table, column, key, Durable Object field and message shape the current release reads must still be there, and still mean the same thing, after the new release.
2. **Which steps does it need?** Pick from the steps below. Most changes need expand, then switch; a removal needs contract in a later release.
3. **Which release does each step land in?** Write it in the plan. Contract steps go in a wave after a release.
4. **Is anything one-way?** If yes, say why it can't be two-way, and plan the restore point and forward fix (ADR-008).

## The steps

Each issue that changes persisted data declares one step in its **Data change** line, for example `expand, two-way`.

| Step | What it does | Direction |
| --- | --- | --- |
| `expand` | Adds a table, column, key or field. New columns are nullable or have a default. Old code ignores them | Two-way |
| `migrate` | Copies or transforms data into the new shape, as a backfill job. The old shape stays and stays correct | Two-way |
| `switch` | Code starts reading the new shape and writing both. Behind a flag when the change is risky | Two-way |
| `contract` | Removes the old shape, after a release in which no code reads it | One-way |

## Patterns

**Rename or retype a column.** Never in place. `expand` the new column, `switch` code to write both and read the new one, `migrate` old rows, release, then `contract` the old column in a later release.

**Add a required field.** `expand` it as nullable or with a default. `migrate` existing rows. Enforce "required" in code first; add a database constraint only in a later release, once every writer sets it.

**Split or merge tables.** Same as a rename, one level up: build the new tables beside the old, dual-write, backfill, switch reads, release, then drop.

**Backfills.** A separate job, not part of the migration. Idempotent (safe to run twice), resumable (keeps its position), and batched (bounded rows per run). It runs after the `expand` release is live, and the code works whether or not it has finished.

**Feature flags.** Put new read and write paths behind a flag when the switch is risky. Turning a flag off is a rollback with no deploy. Remove the flag in a later issue once the release has settled.

**Stored blobs and Durable Object state** (KV values, JSON columns, DO storage). Version the shape (`"v": 2`). Readers accept the current and previous versions. Writers move to the new version only in the `switch` step.

**Durable Object migrations.** Adding a class is `expand`. Renaming, transferring or deleting a class is `contract`, and one-way: plan it as such.

**Messages and queues.** Consumers accept the old and new message shapes before any producer sends the new one. Producer and consumer changes go in separate releases when they deploy separately.

**Shadow reads.** For a risky read path, read both old and new, serve the old, and log differences. Switch when the differences are zero.

## Tests

- A migration issue's acceptance includes a test that applies the migration and then runs the previous release's data-access tests against it, where the repo makes that possible.
- A backfill has a test that runs it twice and checks the result is the same.

## When one-way can't be avoided

Say so in the plan and in the issue's **Data change** line (`contract, one-way`). The release that carries it needs a restore point taken right before the migration, a forward-fix plan instead of a rollback plan, and the operator's acknowledgment in the release PR (ADR-008).
