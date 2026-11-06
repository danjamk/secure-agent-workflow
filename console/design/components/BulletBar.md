# BulletBar

A bullet bar is a compact value bar over shaded bands, with a white target tick and a red limit, built to stack in columns.

## Use

- Per-run budgets in a row: tokens, wall-clock, cost (M2 pager, run tables).
- Wave progress against plan, with the target tick at where the plan says you should be.

## Rules

- Bands: safe `dial-track`, caution and limit tinted from `blocked` and `failed`. Fill takes the zone color (`--z`).
- Target tick is `text-1`; limit is `failed`.
- Label in `label` caps, value in mono right-aligned.
- The consumer provides value, bands, optional target and limit.
