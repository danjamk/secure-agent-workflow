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

`--checks` replaces the required checks. Without it, bootstrap keeps whatever checks the ruleset already requires, so a re-run never drops the gate. `--checks ""` removes them.

Bootstrap manages only its own ruleset. It lists other rulesets on the repo and leaves them alone.

Running claude-shared's `protect-branch.sh` on a bootstrapped repo rewrites `protect-default` without the check pinning. Re-run bootstrap afterward.

Environments, labels and CODEOWNERS come next (#5), then the gate caller (#16).

## Results

2026-10-30, personal Pro account:

| Repo | First run | Second run |
| --- | --- | --- |
| `danjamk/agent-testbed` (public) | 5 changes, all read back | No changes |
| `danjamk/agent-testbed-private` (private) | 3 changes, all read back | No changes |
| `danjamk/secure-agent-workflow` (public) | 3 changes, all read back | No changes |

- Personal Pro accepted every setting on the private repo, including SHA pinning and the fork policy. Nothing needed a public repo except secret scanning, which bootstrap skips on private repos.
- A direct push to `main` from the owner account was rejected ("Changes must be made through a pull request"). The ruleset binds the repo admin when there are no bypass actors.
- `--checks verify-gate` added the check with `integration_id` 15368 (GitHub Actions). A run without `--checks` kept it, and `--checks ""` removed it.
- `GET /repos/{owner}/{repo}` can return old values for a few seconds after a write. The read-back retries for up to 8 seconds before calling a setting refused.

## Other options for a fork

| Situation | What changes |
| --- | --- |
| Repo owned by a GitHub organization | Org rulesets can apply the same ruleset to many repos at once. On Team, push rulesets can block `.github/**` for every actor, not only the agent App |
| A different required-check source | Change `apps/github-actions` in `ruleset()` to the App that reports your checks |
| Another forge | Bootstrap is GitHub-specific. The model maps to protected branches, merge request approval rules and CI permissions elsewhere, but the script is a rewrite |
