# Bootstrap

Applies secure-agent-workflow's repo controls to one repo, as code. One command, safe to re-run (spec 0001, developer experience requirement 1).

```bash
bash bootstrap/bootstrap.sh <owner>/<repo> --dry-run   # show what would change
bash bootstrap/bootstrap.sh <owner>/<repo>             # apply, then read back
bash bootstrap/bootstrap.sh <owner>/<repo> --checks gate-checks,tier-check
```

Run it as a human with admin on the repo. The agent App can't: it has no `administration` permission (ADR-001).

Each setting is read, compared with what bootstrap wants (`diff.py`), and written only if it differs. After writing, every setting is read back and compared again. A setting GitHub refuses fails the run instead of passing silently. A second run prints `No changes.`

| File | What it does |
| --- | --- |
| `bootstrap.sh` | Reads, compares, applies, verifies |
| `diff.py` | Compares desired settings with GitHub's response; desired is a subset |
| `allowed-actions.txt` | Third-party actions allowed beyond GitHub-owned ones |
| `files/` | Templates for files bootstrap writes into the repo. `{{OWNER}}` becomes the repo owner |
| `github-app/` | The agent's GitHub App: manifest, creation, token minting, verification |

## What it sets

| Area | Setting | Why |
| --- | --- | --- |
| Ruleset `protect-default` on the default branch | No force-push, no deletion, linear history, PR required with 0 approvals, no bypass actors | `main` changes only through a PR, for the admin too. Approvals are the tier check's job, not the ruleset's (ADR-003) |
| | Required checks from `--checks`, each pinned to the GitHub Actions app | A check run or status from any other App can't satisfy a required check |
| Merge | Squash only, auto-merge allowed, branch deleted on merge | Tier 1 PRs merge themselves on green |
| Actions | Selected actions only: GitHub-owned plus `allowed-actions.txt`; full-SHA pinning required | A workflow can't pull in an unreviewed or moving action |
| | `GITHUB_TOKEN` read-only by default; Actions can't create or approve PRs | A workflow can't approve its own way past review |
| Forks, public repos | Approval required before any external contributor's fork PR runs workflows | Red-team scenario 7 |
| Forks, private repos | Fork PR workflows off | Same, for private repos |
| Scanning, public repos | Secret scanning and push protection | Free on public repos. Private repos get gitleaks in the merge gate |
| | Dependabot alerts | Turns on the dependency graph, which the gate's dependency review needs. Without it the review fails with "not supported on this repository" |
| Environments | `dev` and `production`, each deployable from the default branch only (a named-branch policy) | Only `main` can deploy (ADR-002). No secrets are created here |
| Labels | `agent:ready`, `agent:stop`, `agent:blocked` | How Dan releases, stops and unblocks agent runs. The orchestrator acts on them only when the repo owner applies them |
| Files | `.github/CODEOWNERS`: tier 3 paths to the repo owner | Routes tier 3 review requests. The tier check is the control |

`--checks` replaces the required checks. Without it, bootstrap keeps whatever checks the ruleset already requires, so a re-run never drops the gate. `--checks ""` removes them.

Bootstrap manages only its own ruleset. It lists other rulesets on the repo and leaves them alone.

Running claude-shared's `protect-branch.sh` on a bootstrapped repo rewrites `protect-default` without the check pinning. Re-run bootstrap afterward.

The gate caller and tier map come next (#16), through the same managed-files mechanism.

## Managed files

The default branch requires a PR, so bootstrap can't write files straight to it. It renders each template in `files/`, compares it with the file on the default branch, and commits any difference to the `bootstrap/managed-files` branch, with one PR for all of them.

- Re-running with the PR still open updates that PR. It never opens a second one. A file already in the open PR shows as `pending in PR #N` and doesn't count as a change.
- Every managed file starts with the line `Managed by secure-agent-workflow bootstrap`. If the repo already has the file without that line, bootstrap leaves it alone and prints the lines to merge in by hand.
- Files have no read-back step. They take effect when you merge the PR.

## Results

2026-10-30, personal Pro account, ruleset and settings (#4):

| Repo | First run | Second run |
| --- | --- | --- |
| `danjamk/agent-testbed` (public) | 5 changes, all read back | No changes |
| `danjamk/agent-testbed-private` (private) | 3 changes, all read back | No changes |
| `danjamk/secure-agent-workflow` (public) | 3 changes, all read back | No changes |

- Personal Pro accepted every setting on the private repo, including SHA pinning and the fork policy. Nothing needed a public repo except secret scanning, which bootstrap skips on private repos.
- A direct push to `main` from the owner account was rejected ("Changes must be made through a pull request"). The ruleset binds the repo admin when there are no bypass actors.
- `--checks verify-gate` added the check with `integration_id` 15368 (GitHub Actions). A run without `--checks` kept it, and `--checks ""` removed it.
- `GET /repos/{owner}/{repo}` can return old values for a few seconds after a write. The read-back retries for up to 8 seconds before calling a setting refused.

Environments, labels and CODEOWNERS (#5), on both testbeds:

| Repo | First run | Second run |
| --- | --- | --- |
| `danjamk/agent-testbed` (public) | 7 settings, all read back; CODEOWNERS PR #2 opened | No changes; CODEOWNERS pending in PR #2 |
| `danjamk/agent-testbed-private` (private) | 7 settings, all read back; CODEOWNERS PR #2 opened | No changes; CODEOWNERS pending in PR #2 |

- Personal Pro allows environments with deployment branch policies on private repos.
- Changing the template and re-running updated the open PR in place; no second PR was opened.
- Not tested: a repo that already has its own CODEOWNERS. The leave-alone path is read in code review only.
- Applied to this repo on 2026-10-30, while enabling Dependabot alerts for the gate (#14). Its CODEOWNERS PR is #27.

## Other options for a fork

| Situation | What changes |
| --- | --- |
| Repo owned by a GitHub organization | Org rulesets can apply the same ruleset to many repos at once. On Team, push rulesets can block `.github/**` for every actor, not only the agent App |
| A different required-check source | Change `apps/github-actions` in `ruleset()` to the App that reports your checks |
| Another forge | Bootstrap is GitHub-specific. The model maps to protected branches, merge request approval rules and CI permissions elsewhere, but the script is a rewrite |
