# FeedStatus

Feed status says whether the console is live, and defines the degraded tier: what keeps working when the rich views or data feed fail.

## States

- **Live**: a quiet `well` chip with a `running` dot. Shown in the header.
- **Lost** (`oc-feed--lost`): caution stripes with "FEED LOST" and the elapsed time since the last update. The andon strip adds a lit ▲ FEED lamp.

## The degraded tier

When the feed is lost:

- Master caution, the andon strip and Stop render from a minimal path and keep working.
- Andon values become last-known (`oc-lamp--stale`).
- Rich views (lines, traces, logs) desaturate (`oc-degraded`) and show "stale". They are never blanked, so the operator still sees the last state.
- Stop stays fully active. A stop pressed while degraded shows its sequence once the feed returns.

The consumer provides connection state and last-update time.
