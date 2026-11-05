# SlotRing

The slot ring shows the global concurrency cap: one segment per run slot, colored by the run in it; a dark segment is a free slot.

## Rules

- Segment color is the occupying run's state (`running`, `blocked` while the slot is held).
- Free segments are `dial-track`. A full ring with a non-empty queue means work is waiting for a slot.
- The center shows used/total in mono. The legend lists each slot's issue.
- Pair with the queue lamp on the andon strip.
- The consumer provides slot count and the run in each slot.
