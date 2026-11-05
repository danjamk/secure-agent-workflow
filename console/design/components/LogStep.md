# LogStep

The run log is terminal-style text in a display well, grouped into collapsible steps, with secrets already redacted upstream.

## Rules

- Each step: time in `text-3`, a ▸/▾ disclosure, then the step summary ("Ran tests: 42 passed"). Results use ✓ in `running` and ✕ in `failed`.
- Redacted values render as `oc-redacted`: the literal `[redacted]` in `text-3` on `dial-track`. The console never un-redacts.
- Auto-scroll while at the bottom; when the operator scrolls up, show "Jump to live" and stop following.
- Pager: the last 3–5 steps, collapsed. Desktop: the full log.
- The consumer provides steps, their children and the live flag.
