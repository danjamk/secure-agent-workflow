<!--
Issue template for work a build agent picks up. One issue is one agent run
and one pull request.

Title: imperative, and it stands on its own. "Add the coordinator queue",
not "Coordinator".

Before saving:
- Set GitHub's "blocked by" relationship for every issue this one waits on.
  The coordinator reads those links when the issue is dispatched.
- Add exactly one area:<name> label for the part of the codebase it changes.
  Two issues with the same area never run at the same time.
- Size it for one reviewable PR. If the tasks reach into a second area, split
  the issue.

Delete this comment.
-->

## Background

<Why this exists and what it's part of, in one or two short paragraphs. Name the spec section, ADR or plan it comes from.>

Expected tier: <1, 2 or 3>, because <the paths it changes>.

## Tasks

- [ ] <A concrete change, small enough to check off.>
- [ ] <A concrete change.>
- [ ] Tests for <what the tests cover>.

## Acceptance

The agent runs these before marking the PR ready. Each must pass.

```bash
make check
```

- <An observable result, for example: "a PR that changes only docs/ is tier 1".>

## References

- <Spec section, ADR, plan, or external docs URL.>
