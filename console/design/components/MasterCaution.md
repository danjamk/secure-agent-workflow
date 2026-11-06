# MasterCaution

The master light is the single summary of everything that needs the operator; it opens the annunciator panel of named alerts.

## States

- **Unlit**: count 0, `well` lens, `text-3` legend. Normal.
- **Caution** (`oc-master--caution`): one or more caution alerts (blocked run, approval waiting, spend paused). Caution gradient, `on-caution`.
- **Warning** (`oc-master--lit`): one or more warnings (failed run, credential check failing, controls breached). Warning gradient, `shadow-master` glow. The legend reads MASTER WARNING.
- Add `oc-master--flash` once when it lights: a single 900 ms flash, then steady. Never loop.

## Rules

- Count is unacknowledged alerts. Acknowledging dims an alert without removing it; the light goes out only when all are acknowledged or resolved.
- It renders from the critical path and survives a lost feed.
- Desktop: top-left of the andon board. Pager: the andon strip carries the same summary instead.
