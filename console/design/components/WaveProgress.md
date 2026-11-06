# WaveProgress

Wave progress shows a wave as one segment per issue, colored by state, with the merged count.

## Rules

- Segment order: merged first, then running, approval, blocked, failed, waiting.
- Merged segments are `merged` (neutral), so attention lands on the colored remainder.
- The header reads "N of M merged" in mono; a second line shows tier 2 approvals against plan.
- Pager: tapping opens the wave's run list. Desktop: opens the line view.
