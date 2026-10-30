# ADR-003: The tier check is a reusable workflow, not policy-bot

Status: Accepted · Date: 2026-10-30

## Context

The merge gate routes PRs by the paths they touch: tier 1 merges on green, tiers 2 and 3 need Dan's approval. Something has to compute the tier and block until the right approval exists.

## Decision

A reusable GitHub Actions workflow in this repo computes the tier from changed paths against `standards/tier-map.yml` and fails until the required approval exists. It re-runs on `pull_request_review` events. Consumer repos call it pinned by SHA and mark it a required check.

## Alternatives considered

- **policy-bot (Palantir).** Mature and path-aware, but it is a GitHub App Dan would have to host and keep running.
- **CODEOWNERS with required review.** Can't express "no approval needed" for tier 1 paths.
- **Rulesets alone.** Can require approvals but can't vary the requirement by path.

## Consequences

- No extra service to run.
- The tier map lives in each repo and is itself tier 3, so the agent can't change which paths it may merge.
