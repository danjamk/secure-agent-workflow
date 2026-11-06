# EnvelopeDial

The spend gauge is a physical needle dial for spend today against the daily limit, with a second needle for where spend lands at midnight at the current burn rate, and a toggle to a day-runway chart.

## Dial face

- **Housing:** a bezel ring (`key-top`→`seam`) with one hairline highlight across the top, a `seam` inner lip, and a face that fades `well-top`→`well`. A faint glass highlight sits over the upper half.
- **Scale:** 240° sweep. Minor ticks every $5 in `text-3`, major ticks and mono numerals every $15 in `text-2`. A thin band shows the zones: safe `running`, caution `blocked`, and a red limit mark in `failed`. A stop pin sits just past the limit.
- **Needles:** the solid tapered needle is spend now, colored by zone, with a soft drop shadow. The hollow `failed` pointer on the outer rim marks the end-of-day forecast, clear of the readouts; when the forecast passes the limit it rests on the stop pin.
- **Readouts:** spend in `readout-dial` under the hub, colored by zone; "LIMIT $75" below it; a forecast chip ("◇ $103 by 24:00") in the lower opening of the dial.
- **Runway line:** under the face, "pauses 19:37 · 5h 17m": the time the queue pauses at the current rate. This is the decision the gauge exists for.

## Runway face

The Dial / Runway toggle (`oc-seg`, `aria-selected` on the active key) swaps the face: add `oc-gauge--runway` to show a chart of today, 00 to 24: spend so far as a line, the projection as a dashed line with a cone for burn-rate variance, the caution and limit bands, and a marker where the projection crosses the limit. Use it when the trend matters more than the current value. The preview shows both faces side by side; in the app the toggle switches one gauge.

## Props

The consumer provides: spend now, caution threshold, daily limit, forecast at midnight, pause time and time left, the current hour, and today's spend series. The default face is Dial; remember the viewer's choice per device.

## Rules

- Needle moves take 600 ms on `cubic-bezier(.2,0,0,1)`. No idle motion.
- Depth stays 4b subtle: two-stop fades only, one highlight, one shadow. No chrome, no reflections beyond the faint glass arc.
- Pager Phase 1 uses the collapsed form: a `BulletBar` row for spend plus the runway line.
- Per-run budgets (tokens, wall-clock, cost) use `BulletBar`, not this dial.
