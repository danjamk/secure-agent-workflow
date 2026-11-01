---
name: release-prep
description: Prepare a production release. Lists what changed since the last release, classifies every data change as two-way or one-way, ranks the risks with mitigations, and writes the verification and rollback plan into the release PR body. Run by the planning agent; the operator approves the release.
---

# Prepare a release

Use when the operator says "prep the release", "what's in this release", "is main ready for production", or `/release-prep`.

The release PR (spec 0001, Releases) carries everything merged to `main` since the last release. This skill writes its body from `standards/release-template.md`. It doesn't open, approve or merge the release PR.

## Step 1: What changed

- The merged PRs: `gh api 'repos/{owner}/{repo}/compare/production...main' --jq '.commits[].commit.message'`, then each PR's number, tier line and labels.
- The PR audit's batch summary on the release PR, if it exists yet.
- Dependency changes from lockfile diffs, and the infrastructure plan from the release PR's OpenTofu plan check.

Group user-visible changes first, then internal ones. Every line links its PR.

## Step 2: Data changes and direction

For each PR that changed persisted data, read its issue's **Data change** line and check it against the diff (`standards/data-change-patterns.md`):

- Migrations under `**/migrations/**`, Durable Object migrations in `wrangler.*`, and code that changes a stored shape (KV values, JSON columns, DO storage, message formats).
- A diff that removes or renames what the previous release reads is a `contract` step, whatever the issue said. Flag the mismatch.

The release is **one-way** if any change is one-way (ADR-008). Say so on the first line of the body, with the reason.

## Step 3: Risks and mitigations

Rank the risks, highest first. Look at:

- Tier 2 PRs: auth and permission code, dependencies, migrations, deploy config.
- Data changes, and backfills that must finish before a `switch`.
- PRs with open or overridden audit findings, send-backs or escalations in their run record.
- Changes to anything users depend on: URLs, APIs, data they see.

Each risk gets a mitigation: a flag, a test, a staging check, a watch signal, or splitting the release. A high risk without a mitigation is a reason to recommend holding.

## Step 4: Verification and rollback

- **Before deploy:** what to check on staging, specifically: which screens, which smoke tests, which data.
- **After deploy:** `/health` reports the release's build id, and the smoke tests pass. Add any release-specific checks.
- **Watch window and rollback trigger:** how long, which signals, and the observable condition that means roll back.
- **Rollback:** the steps from the template, plus any flag to turn off first and any infrastructure change to revert. State what users lose if it's rolled back, if anything.
- **One-way releases:** the restore point to take, the forward-fix plan, and the acknowledgment box.

## Step 5: Recommend and hand over

End the body's first block with one recommendation: ship, ship after a named fix, or hold, with the reason.

If the release PR exists, update its body (`gh api -X PATCH repos/{owner}/{repo}/pulls/{n} -f body=...`). Otherwise give the operator the body to paste. Then stop. The operator approves the release.

## After the release

When the operator asks "how did the release go", compare the watch-window signals with the release's rollback trigger, and report: shipped clean, rolled back, or forward-fixed, with links. Add anything worth learning to the next retro's evidence.
