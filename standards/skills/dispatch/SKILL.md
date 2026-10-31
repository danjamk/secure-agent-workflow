---
name: dispatch
description: Dispatch a wave of issues to build agents. Shows each issue's area and open blockers, flags problems, then labels the wave agent:ready after the operator confirms. Run by the operator on their own machine, never by an agent.
---

# Dispatch a wave

Use when the operator says "dispatch", "release wave N", "start the agents on …", or `/dispatch <milestone or issue numbers>`.

Dispatching starts autonomous work, so it is the operator's decision. This skill shows exactly what will happen and labels nothing until the operator says yes.

It works only where `gh issue edit` works: on the operator's machine. In a Claude Code cloud session the GitHub proxy blocks GraphQL, so `gh issue edit` fails there, and the deny rules from the planning agent guide (`docs/guides/planning-agent.md`) block adding the label through `gh api`. That is intended: the planning agent must not dispatch.

## Step 1: Identify the wave

Take the target from the operator's message:

- A milestone, such as `"Wave 2: reports"`. This is the normal case: one wave is one milestone.
- Or a list of issue numbers.

If it's unclear, ask. Find the repo with `gh repo view --json nameWithOwner --jq .nameWithOwner`.

## Step 2: Gather each issue

List the open issues in the milestone:

```bash
gh issue list --milestone "<milestone>" --state open --limit 100 --json number,title,labels
```

For each issue, read its blockers (one call per issue):

```bash
gh api repos/<owner>/<repo>/issues/<n>/dependencies/blocked_by --jq '.[] | "#\(.number) \(.state) \(.state_reason)"'
```

## Step 3: Show the plan and flag problems

Present one table, in issue order:

| Issue | Area | Blocked by (open) | Will |
| --- | --- | --- | --- |
| #41 (add the parser) | `area:pipeline` | — | Start when a slot is free |
| #42 (parser tests) | `area:pipeline` | #41 | Wait for #41 |

Under it, list anything that needs the operator's attention:

- **No `area:*` label, or more than one.** No label means the issue locks every area and runs alone (ADR-005). Recommend adding one.
- **A blocker closed as `not_planned`.** The coordinator keeps the issue waiting. Recommend removing the relationship or reopening the blocker.
- **A blocker outside this wave that is still open.** The issue waits on work nobody has dispatched.
- **Already labeled `agent:ready`.** Skip it; it's already dispatched.
- **Labeled `agent:stop`.** Skip it, and say so; remove `agent:stop` first if it should run.
- **No acceptance section in the body.** The agent won't know what "done" means. Recommend fixing it first.

If the plan recommends a concurrency cap for this wave, show it, and remind the operator that the cap is the orchestrator's `MAX_CONCURRENT_RUNS` setting, which this skill doesn't change.

## Step 4: Confirm

Ask: "Dispatch these N issues?" Recommend fixing the flagged problems first if there are any. Wait for a yes.

## Step 5: Label

Label each issue, one command per issue, so each can be declined:

```bash
gh issue edit <n> --add-label agent:ready
```

Stop at the first failure and report it. Don't continue past it.

## Step 6: Report

List the dispatched issues by number and title, and which ones the coordinator will start first (no open blockers, distinct areas). Point the operator at the daily digest or the board for progress.
