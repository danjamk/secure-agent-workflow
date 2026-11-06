# Stop

Stop is the andon cord: one control that ends a run, held deliberately, always visible, never in a menu.

## States

1. **Idle**: "Hold to stop", empty ring around the stop glyph.
2. **Holding**: the ring fills clockwise while the operator holds. Label "Keep holding". Releasing early empties the ring and does nothing.
3. **Stopping**: ring full, the control breathes (`oc-breathe`, 1 s loop) until the system confirms.
4. **Stopped**: flat `well` fill with a `stopped` outline and a `text-2` label. Below it, a sequence log confirms each step: stop requested by the operator's login, sandbox torn down, access token revoked.

## Rules

- Hold time: 1.5 s. This value is an assumption; tune it in testing.
- Uses `stop-top`→`stop-bottom`, `on-stop` label, `shadow-key-stop` guard ring, `radius-pill`. Never reuse these for anything else.
- Desktop: 36px, in the run header. Pager: `oc-stop--lg`, 56px, full width at the bottom of the screen, within thumb reach.
- Stop renders from the critical path: it must keep working when the data feed is lost (see `FeedStatus`).
- Keyboard: hold Space or Enter for the same duration; the ring shows progress.
- Announce each state change to screen readers ("Stopping run 42", "Run 42 stopped").

The consumer provides the run's issue number, the hold handler and the stop sequence events.
