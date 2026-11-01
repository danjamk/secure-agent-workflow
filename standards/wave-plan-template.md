# Plan: <name>

Status: Draft · Date: YYYY-MM-DD · Spec: <link to docs/specs/NNNN-*.md>

<!--
Save as docs/plans/<slug>.md and open it as a PR. Issues are created only
after this plan is merged. Follow wave-planning.md.

Give each issue a key (W1-1, W1-2, ...) so "blocked by" can refer to issues
that don't have numbers yet. When the issues are created, each one's body
names its plan and key ("Plan: docs/plans/<slug>.md, W1-1"), and the keys in
"Blocked by" become GitHub "blocked by" relationships between the new issues.

Delete this comment.
-->

## Summary

<What this plan delivers, in two or three sentences.>

| Wave | Goal | Issues | Tier 2 or 3 PRs | Runs | Recommended cap | Profiles |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | <goal> | <n> | <n> | <in parallel / one at a time> | <n> | <e.g. 1 frontier-high, 4 standard-medium> |
| 2 | <goal> | <n> | <n> | <...> | <n> | <...> |

## Wave 1: <goal>

Milestone: `Wave 1: <goal>`

**Operator tasks before dispatch:** <tier 3 changes, accounts, secrets; or "None".>

**Runs:** <in parallel or one at a time>, because <reason>. Recommended cap: <n>.

**Done when:** <what the operator can see or test on staging after the last PR merges.>

**Data changes:** <none, or the steps in this wave and the release each must ship in. Contract steps belong in a wave after a release (ADR-009).>

### W1-1: <imperative title>

- **Area:** `area:<name>`
- **Expected tier:** <1, 2 or 3>, because <paths>
- **Run profile:** <class-effort>, because <reason>
- **Data change:** <none, or step and direction>
- **Blocked by:** <keys, or "nothing">

**Background.** <Why, in one or two sentences.>

**Tasks**

- [ ] <task>
- [ ] Tests for <what>.

**Acceptance**

```bash
make check
```

- <observable result>

**References:** <spec section, ADR, docs URL>

### W1-2: <imperative title>

<Same shape.>

## Wave 2: <goal>

<Same shape.>
