# AlarmCard

An alarm card is one thing that needs the operator. The same object appears on the pager list, in the desktop "Needs you" rail, and as the landing for a Slack deep link, at three densities.

## Kinds

- **Blocked** (`oc-alarm--blocked`): the agent's question quoted in `card-title`, the issue and labels in `meta`. Actions: answer chips when the question has discrete answers, **Reply in GitHub**, **Acknowledge**. Reply goes to the issue comment with the handoff note if no PR exists, otherwise the PR.
- **Approval** (`oc-alarm--approval`): tier tag, the PR and its one-line reason, checks and audit result. Action: **Approve in GitHub** only.
- **Alert** (`oc-alarm--alert`): a named condition (credential failing, blocker closed as not planned, PR still conflicting, ignored dispatch label, queue paused for spend).

## Densities

- Full (default): the deep-link landing and pager detail.
- `oc-alarm--compact`: pager list, desktop rail.
- `oc-alarm--row`: one 36px line for the annunciator panel and dense lists.

## Acknowledged

`oc-alarm--ack` dims the card to 55% and shows who acknowledged it and when. It stays listed until resolved. Acknowledgement syncs across devices.

## Rules

- Order: blocked, then approvals, then alerts; within each, oldest first.
- Priority tags `P1`–`P3` use caution; tier tags use `approval`.
- No approve or merge action in the console, ever.
