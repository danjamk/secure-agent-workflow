# StatusGlyph

Every run state has a shape and a color, so state reads without color: filled circle running, outlined circle waiting, triangle blocked, diamond approval, square failed, ring-with-dot merged, outlined square stopped.

## Usage

`<span class="oc-status oc-status--running"><svg>…</svg><span>running</span></span>`. States: `running`, `queued` and `waiting` (same glyph; the word differs), `blocked`, `approval` (the run is in review waiting for approval), `failed`, `merged`, `stopped`.

## Rules

- Always show the word beside the glyph except inside an `IssueToken`, where the token's treatment carries the state.
- Running glows faintly; nothing else glows outside lit lamps.
- `stopped` is below 3:1 on panels; its word is set in `text-2`.
- The word is lowercase in `legend` (Martian Mono 10.5px).

For UI and wait-reason icons, use Lucide at 1.5px stroke: activity, hourglass, lock, layers, link-2, coins, key-round, github, arrow-down-to-line, chevron-right.
