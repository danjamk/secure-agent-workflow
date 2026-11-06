# Operator console design

The visual system and Phase 1 screens for the operator console (spec 0002). Direction 4b subtle, dark theme only. Built in Claude Design; this folder is the copy the build uses.

## Files

| Path | What it is |
| --- | --- |
| `tokens.json` | Every color, type style, spacing step, radius and shadow, with a usage note on each. The source of truth for values |
| `tokens.css` | The same tokens as CSS custom properties. Generated from `tokens.json`; do not edit by hand |
| `components.css` | Component styles, `oc-` prefix. Reads only the tokens |
| `components/<Name>.md` | One spec per component: what it is, variants and states, rules, what the consumer provides |
| `screens/phase-1.md` | The Phase 1 screens: layout, sections, rows, states, data fields and link-outs |
| `reference/*.dc.html` | The approved Phase 1 artboards as HTML, for exact spacing and copy. They use these stylesheets; open one in a browser to see it |

Build against `tokens.css` and `components.css`, and match `reference/` for layout and copy. When a screen needs something the system lacks, add it to `tokens.json` and a component spec first.

## Brand book

Operator Console is the visual system for supervising a software factory: AI coding agents working GitHub issues in sandboxes, watched by one operator on a desktop control room and a mobile alarm pager. It reads like a machine: a physical chassis, recessed display wells, lit lamps and keycaps, cockpit instruments, trading-terminal density. Dark theme only.

## Principles

- **Dark means normal.** A healthy factory is unlit. Color appears only where the operator is needed: blocked, approval, failed, caution, warning. If a screen is colorful, something is wrong.
- **Supervise, don't fly.** The operator watches and intervenes. Few actions: stop a run, acknowledge an alarm, and on desktop, dispatch. Approve and reply always leave the console for GitHub.
- **Shape before color.** Every state has a glyph shape and a word. Color confirms; it never carries meaning alone.
- **Every instrument has a decision.** A dial or trace exists only if crossing its limit changes what the operator does.
- **The critical path survives.** Master caution, the andon strip and Stop keep working when the data feed is lost.

## Content

- Use the domain terms exactly: issue, wave, run, slot, area lock, tier, run profile, blocked, preview, staging, production.
- Run states, lowercase: queued, waiting, running, blocked, in review, merged, failed, stopped.
- Key labels are sentence case and verbs: "Hold to stop", "Acknowledge", "Approve in GitHub ↗".
- Engraved labels on lamps, dials and wells are capitals in `label`: "SPEND / TODAY", "TOKEN_BURN / RUN #42".
- Quote the agent's own question on blocked alarms. Keep the operator's voice out of it.
- Identifiers are mono and literal: `#42`, `area:orchestrator`, `run:standard-medium`, `agent/42-date-picker`.
- Empty states are calm and specific: "Line running normally."
- Never show a secret. Credentials appear by name and status; logs show `[redacted]`.
- No emoji.

## Color

Surfaces stack from the outside in: `chassis-top`→`chassis-bottom` frames a product, `panel-top`→`panel-bottom` raises a card, `well` recesses a display. `seam` outlines every panel and key and draws dividers.

Text: `text-1` for primary text and readouts on every ground. `text-2` for descriptions and unlit lamp values. `text-3` for labels and ticks, on `well` only at small sizes; on panels it misses 4.5:1, so use it there only for caps labels next to a stronger value.

Run states: `running` (blue signal), `waiting`, `blocked` (amber), `approval` (cyan), `failed` (red), `merged` (neutral, done work recedes), `stopped`. The same hues band instruments: safe in `running`, caution in `blocked`, limit in `failed`.

Lit lamps use their own gradient pairs with dark text: caution `caution-top`→`caution-bottom` with `on-caution`; warning `warning-top`→`warning-bottom` with `on-warning`. The Stop control alone uses `stop-top`→`stop-bottom` with `on-stop`.

## Depth (4b subtle)

- Gradients are very light two-stop vertical fades on keys, lamps and chassis, always between a `-top` and `-bottom` token pair at 180°. Never a hue shift, never more than two stops.
- One hairline top highlight per raised object (inside the `shadow-` tokens).
- Wells are recessed with `shadow-well`; the andon bezel with `shadow-bezel`.
- Glow belongs only to lit lamps (`shadow-lamp-caution`, `shadow-lamp-warning`, `shadow-master`), the primary key and the running glyph.

## Type

- `sans` (Instrument Sans) for interface text and keys: `title`, `heading`, `card-title`, `body`, `key`.
- `mono` (IBM Plex Mono) for every number and identifier: `readout-xl`, `readout-dial`, `readout-lamp`, `readout-trace`, `meta`, `tag`. Use tabular figures.
- `label` (Martian Mono) only for small engraved labels: `label`, `label-strong`, `legend`.
- All three load from Google Fonts.

## Spacing and shape

- Rows: `row-dense` 28px for desktop tables and the annunciator; `row` 36px default and key height; `hit` 44px minimum touch target on the pager.
- Gaps: `space-3` between lamp tiles, `space-5` between keys, `space-6` card padding, `space-7` between screen sections.
- Corners grow with the object: `radius-xs` tags, `radius-sm` lamps, `radius-md` keys, `radius-lg` wells, `radius-panel` cards, `radius-chassis` frames. `radius-pill` is reserved for Stop.

## Motion

Motion only when the machine is doing something. Respect `prefers-reduced-motion`.

- Running pulse: `oc-pulse`, 1.6 s loop, on running tokens and dots.
- Master light: `oc-flash-once`, one 900 ms flash when it lights, then steady.
- Stopping: `oc-breathe`, 1 s loop until stopped.
- Needles and fills: 600 ms, `cubic-bezier(.2,0,0,1)`.
- Stop hold: 1.5 s ring fill (assumption; tune in testing).

## Iconography

- Run states use the system's own geometric glyphs (see `StatusGlyph`): circle, ring, triangle, diamond, square, ring-with-dot, outlined square.
- UI and wait-reason icons use Lucide at 1.5px stroke: `lock` (area lock), `layers` (slot), `link-2` (blocker), `coins` (spend), `key-round` (credential), `github`, `arrow-down-to-line` (jump to live), `chevron-right`.
- Level prefixes on lamps: ▲ caution, ■ warning. Leaving the console: ↗.
- No logo exists yet; set the product name in `title`.

## Layout

- Pager (390px): andon strip on top, alarm list, Stop at the bottom within thumb reach. Two actions only: Stop and Acknowledge.
- Control room (1440px): andon board and master caution across the top, production lines in the center, "Needs you" rail on one side, logs one level down.
- Place by frequency of use: alarms and Stop first, then lines, then gauges, then logs, then credentials.

## Components

Controls: `Key`, `Stop`. Annunciation: `MasterCaution`, `AndonStrip`, `FeedStatus`. Status: `StatusGlyph`, `IssueToken`. Alarms: `AlarmCard`. Instruments: `EnvelopeDial`, `BulletBar`, `SlotRing`, `TelemetryTrace`. Data: `LogStep`, `WaveProgress`. All are plain CSS classes in `components/bundle.css` (prefix `oc-`); each component's README lists its classes and states.
