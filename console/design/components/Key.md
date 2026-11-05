# Key

Keys are the console's buttons: one primary key per view, secondary keys for everything else, and outlined link-out keys for anything that leaves the console.

## Variants

- `oc-key oc-key--primary`: the one consequential in-console action on a view, such as **Dispatch wave**. `signal` gradient, `text-bright` label.
- `oc-key`: secondary, such as **Acknowledge**. `key-top`→`key-bottom`, `text-1` label at weight 500.
- `oc-key oc-key--out`: leaves the console for GitHub. Outlined, no fill, with a trailing `↗`. Use for **Approve in GitHub**, **Reply in GitHub**, **Open PR**.
- `oc-key--chip`: a 28px mono chip, added to `--out` for one-click recommended answers to a blocked agent (`/health`, `/api/health`). Each chip opens the GitHub reply pre-filled.

## Rules

- Labels are sentence case in `key` (Instrument Sans). Never capitals on keys; capitals belong to engraved labels.
- The console never approves or merges. Approval is always an `--out` key; never style it primary.
- Stop is not a key. Use `Stop`.
- In v1, dispatch and re-dispatch are disabled or show the `/dispatch` command to copy.
- Keys are 36px (`row`) high; on the pager, wrap them in a 44px (`hit`) target.
- Focus: 2px `approval` outline, 3px offset.

The consumer provides the label, the href for link-outs, and the disabled state.
