# Bootstrap

Applies secure-agent-workflow's repo controls to one repo, as code. One command, safe to re-run (spec 0001, developer experience requirement 1).

```bash
bash bootstrap/bootstrap.sh <owner>/<repo> --dry-run   # show what would change
bash bootstrap/bootstrap.sh <owner>/<repo>             # apply, then read back
bash bootstrap/bootstrap.sh <owner>/<repo> --checks deploy-preview   # require extra checks
bash bootstrap/bootstrap.sh <owner>/<repo> --update-gate <sha>       # move the gate pin
bash bootstrap/bootstrap.sh <owner>/<repo> --check                   # drift check: exit 1 on any difference
```

`--check` reads every setting and file like `--dry-run`, writes nothing, and exits 1 if anything differs from what bootstrap wants. Run it by hand, or from anything that holds an admin token. A workflow's `GITHUB_TOKEN` can't read admin settings such as the Actions policy, so it can't run in a scheduled job without storing an admin credential.

Run it as a human with admin on the repo. The agent App can't: it has no `administration` permission (ADR-001).

Each setting is read, compared with what bootstrap wants (`diff.py`), and written only if it differs. After writing, every setting is read back and compared again. A setting GitHub refuses fails the run instead of passing silently. A second run prints `No changes.`

| File | What it does |
| --- | --- |
| `bootstrap.sh` | Reads, compares, applies, verifies |
| `diff.py` | Compares desired settings with GitHub's response; desired is a subset |
| `allowed-actions.txt` | Third-party actions allowed beyond GitHub-owned ones |
| `files/` | Templates for files bootstrap writes into the repo. `{{OWNER}}` becomes the repo owner, `{{DEFAULT_BRANCH}}` its default branch, and `{{GATE_REPO}}` and `{{GATE_SHA}}` the gate pin |
| `github-app/` | The agent's GitHub App: manifest, creation, token minting, verification |

## What it sets

| Area | Setting | Why |
| --- | --- | --- |
| Ruleset `protect-default` on the default branch | No force-push, no deletion, linear history, PR required with 0 approvals, no bypass actors | `main` changes only through a PR, for the admin too. Approvals are the tier check's job, not the ruleset's (ADR-003) |
| | Required checks: the gate's 7 (`GATE_CHECKS`) plus any from `--checks`, each pinned to the GitHub Actions app | A check run or status from any other App can't satisfy a required check |
| Merge | Squash only, auto-merge allowed, branch deleted on merge | Tier 1 PRs merge themselves on green |
| Actions | Selected actions only: GitHub-owned plus `allowed-actions.txt`; full-SHA pinning required | A workflow can't pull in an unreviewed or moving action |
| | `GITHUB_TOKEN` read-only by default; Actions can't create or approve PRs | A workflow can't approve its own way past review |
| Forks, public repos | Approval required before any external contributor's fork PR runs workflows | Red-team scenario 7 |
| Forks, private repos | Fork PR workflows off | Same, for private repos |
| Scanning, public repos | Secret scanning and push protection | Free on public repos. Private repos get gitleaks in the merge gate |
| | Dependabot alerts | Turns on the dependency graph, which the gate's dependency review needs. Without it the review fails with "not supported on this repository" |
| Environments | `preview` from PR runs (`refs/pull/*/merge`), `staging` from the default branch, `production` from the `production` branch. Each has one named-branch policy. An old `dev` environment with no deployments is deleted | The broker's roles trust these environment names (ADR-002), so the policy decides which runs can get which credentials. No secrets are created here |
| Labels | `agent:ready`, `agent:stop`, `agent:blocked` | How Dan releases, stops and unblocks agent runs. The orchestrator acts on them only when the repo owner applies them |
| | `credentials` | The daily credential check's one issue (`deploy/README.md`, Daily check) |
| Files | `.github/CODEOWNERS`: tier 3 paths to the repo owner | Routes tier 3 review requests. The tier check is the control |
| | `.github/workflows/gate.yml` and `tier-check.yml`: the gate callers, pinned to a commit of `GATE_REPO` | The merge gate (`gate/README.md`). Two files because the tier check re-runs on every review and the scanners don't need to |
| | `.github/workflows/credential-check.yml`: the daily credential check, running `deploy/credentials/daily-check.sh` from the same pin | Opens an issue when a stored credential fails, expires or is due for rotation (`deploy/README.md`). Skipped with a note when the pin predates it; `--update-gate` adds it |
| | `.github/workflows/deploy.yml`: Cloudflare previews on PRs and staging on the default branch, running `deploy/cloudflare/` from the same pin | `deploy/README.md`, Cloudflare deploys. Does nothing in a repo without a wrangler config. Skipped with a note when the pin predates it |
| | `standards/tier-map.yml`, copied once if the repo has none | The repo's own tier map. No marker: the repo owns it and bootstrap never updates it |

The gate's checks are always required. `--checks` sets the extra checks on top of them. Without it, bootstrap keeps the extras the ruleset already requires; `--checks ""` removes them. No flag drops the gate.

The checks are required as soon as bootstrap runs, before the callers are on the default branch. The bootstrap PR runs the gate on itself, because a `pull_request` run uses the PR's own workflow files. A PR opened before the callers merged gets no gate run, so it stays blocked until it's updated from the default branch.

The gate's `check` job runs `make check`, so the repo needs a Makefile with a `check` target.

### Gate pin

The callers pin `GATE_REPO` (this repo) to a full commit SHA, so a change here reaches a consumer only when the consumer merges a new pin.

| Run | Pin |
| --- | --- |
| First run | The head of `GATE_REPO`'s default branch |
| Re-run | The repo's current pin: the open bootstrap PR's if there is one, then the default branch's |
| `--update-gate <sha>` | That commit, through the bootstrap PR. Refused unless it's on `GATE_REPO`'s default branch, so a branch commit nobody reviewed can't be pinned |

Bootstrap manages only its own ruleset. It lists other rulesets on the repo and leaves them alone.

Running claude-shared's `protect-branch.sh` on a bootstrapped repo rewrites `protect-default` without the check pinning. Re-run bootstrap afterward.

### This repo

Run on `GATE_REPO` itself, bootstrap detects it and switches to self mode (#60). Everything is the same except the files:

| File | Instead of | Why |
| --- | --- | --- |
| `.github/workflows/self-gate.yml` | `gate.yml` | Here `gate.yml` runs the PR's own copy of the gate, as advisory `candidate / *` checks |
| `.github/workflows/self-tier-check.yml` | `tier-check.yml` | Here `tier-check.yml` is the reusable workflow consumers call |

Both pin a commit on the default branch, like a consumer's callers, so a PR is judged by gate code that has already merged, never by its own. The required check names are the same as a consumer's (`checks / *`, `tier / tier-check`).

The self tier check reads `.github/self-tier-map.yml`, which puts this repo's control code at tier 3: `bootstrap/`, `gate/`, `deploy/`, `standards/`, `.github/`, `.claude/`, `Makefile`. The repo keeps that map; bootstrap doesn't write it. The credential check and deploy workflows aren't installed here.

A gate change takes two PRs: the change, checked by the pinned gate and exercised by the `candidate` run, then `bootstrap.sh danjamk/secure-agent-workflow --update-gate <sha>` to move the pin to it.

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

Environments for the branch model (#30), 2026-10-31:

| Repo | First run | Second run |
| --- | --- | --- |
| `danjamk/agent-testbed` (public) | `preview` and `staging` created, `production` moved to the `production` branch, `dev` removed; all read back | No changes |
| `danjamk/agent-testbed-private` (private) | Same | No changes |

A throwaway workflow on the public testbed tried each environment:

| Run | `preview` | `staging` | `production` |
| --- | --- | --- | --- |
| `pull_request` | Allowed | Refused: "Branch "refs/pull/17/merge" is not allowed to deploy to staging" | Refused |
| Push to `main` | — | Allowed | Refused: "Branch "main" is not allowed to deploy to production" |

- **A branch policy is matched against the run's `GITHUB_REF`.** For a `pull_request` run that's `refs/pull/<n>/merge`, never the PR's branch name, so `preview` uses that pattern. GitHub accepts it as a branch-type policy.
- **The OIDC subject includes numeric IDs.** The preview job's token had `sub: repo:danjamk@52805208/agent-testbed@1440138099:environment:preview`. Repos created after July 15, 2026 use this format by default, and older repos can opt in. The broker's trust policies must match it (ADR-002).
- Changing the template and re-running updated the open PR in place; no second PR was opened.
- Not tested: a repo that already has its own CODEOWNERS. The leave-alone path is read in code review only.
- Applied to this repo on 2026-10-30, while enabling Dependabot alerts for the gate (#14). Its CODEOWNERS PR is #27.

Gate callers, required checks and `--update-gate` (#16), on `danjamk/agent-testbed`, 2026-10-31:

| Run | Result |
| --- | --- |
| First run | Ruleset gained the 7 gate checks, read back. PR opened with both callers and the tier map. All 7 checks ran on that PR, and it merged after a `check` target was added to the testbed's Makefile |
| Second run | No changes; pin kept from the default branch |
| `--update-gate` with a commit not on `main`, and with one that doesn't exist | Both refused, nothing written |
| `--update-gate` with a `main` commit | Bootstrap PR opened with the new pin |
| Re-run with that PR open | No changes; pin kept from the PR branch |

The agent's tier 1 and tier 2 PRs on the same repo are in `gate/README.md`.

- Writing `.github/workflows/` through the contents API needs a token allowed to change workflow files (the `workflow` scope on a classic token). The owner's token was.
- Not tested on the private testbed. Nothing in #16 depends on visibility.

## Other options for a fork

| Situation | What changes |
| --- | --- |
| Repo owned by a GitHub organization | Org rulesets can apply the same ruleset to many repos at once. On Team, push rulesets can block `.github/**` for every actor, not only the agent App |
| A different required-check source | Change `apps/github-actions` in `ruleset()` to the App that reports your checks |
| Another forge | Bootstrap is GitHub-specific. The model maps to protected branches, merge request approval rules and CI permissions elsewhere, but the script is a rewrite |
