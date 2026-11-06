# IssueToken

An issue token is one issue on a production line or in a table: its number, treated by state so only the issues that need the operator carry solid color.

## Treatments

- Queued and waiting: outline only (`key-top`), `text-2`. Ghosted.
- Running: `running` outline and text, with a pulsing dot (`oc-pulse`, 1.6 s). Signal, not fill.
- Blocked: solid `blocked`, `on-caution` text.
- In review, needs approval: solid `approval`, `well` text.
- Failed: solid `failed`, `on-warning` text.
- Merged: faint `seam` outline, `text-3`. Done work recedes.
- Stopped: `stopped` outline, `text-3`.

## Wait reasons

A waiting token carries one primary reason badge (`oc-reason`): `blocker #n`, `lock area:<name>` (`oc-reason--lock`), `slot`, `spend`. When there is more than one reason, show the primary badge on the line and list the rest on run detail.

## Hover card (desktop only)

On desktop, hovering or focusing a token opens `oc-hover` beside it: the issue title, state and elapsed time, area (and whether it holds or waits on the lock), run profile, expected tier, budget use, wait reasons, and what it blocks. Clicking the token opens the run panel; the card's issue link leaves for GitHub. Wrap the token in `oc-tokenwrap`. The card shows only on devices with hover (`@media (hover: hover)`); on the pager, tapping a token opens Run check instead.

## Rules

- Only blocked, approval and failed get solid fill. If more than a few tokens are solid, the line is in trouble, which is the point.
- Tokens are 24px high in `meta` mono; on the pager, rows are 44px.
