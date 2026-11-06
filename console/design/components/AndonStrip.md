# AndonStrip

The andon strip is a row of lamp tiles inside a recessed bezel, one per factory-wide condition: queue, slots, spend, coordinator, credentials.

## Lamp states

- **Unlit** (`oc-lamp`): normal. `well-top`→`well`, `text-3` label, `text-2` value.
- **Caution** (`oc-lamp--caution`): needs attention soon. Prefix the label with ▲. Examples: spend over the caution band, queue paused for spend.
- **Warning** (`oc-lamp--warning`): broken now. Prefix the label with ■. Examples: credential check failing, coordinator down.
- **Stale** (`oc-lamp--stale`): the feed is lost and this value is last-known. Struck through in `text-3`; pair with `FeedStatus`.

## Rules

- Dark means normal. A healthy factory shows no lit lamps.
- The glyph prefix (▲ caution, ■ warning) carries the level without color.
- Desktop: across the top of the factory floor, `--n` set to the tile count. Pager: `oc-andon--compact`, five tiles at 358px.
- Credentials show counts and status only, never values.
