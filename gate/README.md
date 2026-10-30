# Merge gate

Reusable workflows a consumer repo calls on every PR, pinned to a commit SHA of this repo (spec 0001, "Merge gate"). Deterministic checks decide; the PR audit can reject but never approve.

| Part | Status |
| --- | --- |
| Tier check (`tier-check.yml`, `tier_check.py`) | Done (#15) |
| Checks and scanners (`gate-checks.yml`) | Done (#14) |
| PR audit | #21 |
| Caller installed by bootstrap | #16 |

## Checks and scanners

`gate-checks.yml` is reusable. Each job is a required check. The job names don't change with visibility, and a job skipped for one visibility reports success.

| Job | Public repos | Private repos |
| --- | --- | --- |
| `check` | The consumer's check command (input `check-command`, default `make check`). Node is set up if there's a `package.json`, pnpm if there's a `pnpm-lock.yaml`, uv if there's a `uv.lock` | Same |
| `dependency-scan` | GitHub dependency review, failing at `moderate` (input `fail-on-severity`) | osv-scanner over every manifest and lockfile |
| `secret-scan` | gitleaks over the PR's commits | Same |
| `code-scan` | CodeQL for JavaScript/TypeScript, Python, Ruby and Actions workflows. `sarif_gate.py` fails the job on security-severity 7.0 or higher, or level `error` | Semgrep CE (`p/default`), failing on `ERROR` severity |
| `misconfig-scan` | Skipped | trivy, vulnerabilities and misconfigurations, `HIGH` and `CRITICAL` |
| `workflow-lint` | actionlint and zizmor, when the PR changes `.github/` | Same |

Notes:

- **Scanners are release binaries pinned by SHA-256** in `tools.txt` and installed by `install-tool.sh`, which refuses a download whose checksum doesn't match. Semgrep ships only through PyPI and Docker, so it runs from its Docker image pinned by digest. No third-party action runs, so a moved release tag can't change what executes. The consumer's actions allowlist needs only the gate itself.
- **Scanners judge the whole repo**, not only lines the PR adds. Agent-built repos start clean, which keeps each check a plain pass or fail.
- **The check command runs the PR's code** with a read-only token and no secrets. Nothing else in the gate executes PR code.
- **gitleaks runs on public repos too.** GitHub's push protection only knows provider-specific token formats.
- **Semgrep fetches its `p/default` rules at run time.** They aren't pinned the way the binaries are.
- **CodeQL languages that need a build** (Go, Java, C#, C/C++) aren't scanned. A repo using them adds its own CodeQL workflow.
- **Dependency review needs the dependency graph.** Bootstrap turns it on by enabling Dependabot alerts on public repos.

Calling it (bootstrap writes the caller in #16):

```yaml
jobs:
  checks:
    uses: danjamk/secure-agent-workflow/.github/workflows/gate-checks.yml@<commit-sha>
    permissions:
      contents: read
      actions: read
      security-events: write
    # with:
    #   check-command: pnpm check
```

This repo runs the gate on its own PRs (`.github/workflows/gate.yml`, calling the local copy) with `make check`.

### Live results

2026-10-30. Each testbed got a PR, under the owner's account, adding a caller pinned to the gate commit, `lodash@4.17.15` (known CVEs), and on the private testbed a fake GitHub token.

| Job | Public testbed | Private testbed |
| --- | --- | --- |
| check | Passed | Passed |
| dependency-scan | Failed: 3 high, 3 moderate lodash advisories (after enabling Dependabot alerts) | Failed: osv-scanner, 6 lodash advisories |
| secret-scan | Passed (no token planted) | Failed: gitleaks, 1 leak |
| code-scan | Passed (CodeQL, Actions language) | Failed: Semgrep found the same token |
| misconfig-scan | Skipped | Failed: trivy, 4 HIGH lodash CVEs |
| workflow-lint | Passed | Passed |

Also verified: `install-tool.sh` refuses a tampered checksum and installs nothing.

## Tier check

Computes a PR's tier from the paths it changes, and fails until the approval that tier needs exists (ADR-003).

| Tier | Passes when |
| --- | --- |
| 1 | Always. Other required checks still have to pass |
| 2 | The approver's latest review is `APPROVED` on the PR's head commit, or the approver authored the PR |
| 3 | As tier 2, and the PR's author is not a bot |

- **The tier map comes from the base commit.** `tier_check.py` reads `standards/tier-map.yml` through the API at the PR's base SHA, never from the PR. A PR can't change the map that judges it. If the repo has no map at the base, the default in this repo is used.
- **Highest tier wins.** A rename counts both the old and the new path, and paths that match no rule are tier 2.
- **Only the approver's login counts.** The approver is the repo owner by default, and must be a `User`, not a bot. The ruleset's approval count isn't used. Other people's approvals, App approvals and stale approvals don't count. A later `CHANGES_REQUESTED` or a dismissal cancels an approval; a `COMMENTED` review doesn't.
- **Bots can't pass tier 3.** GitHub only blocks the agent App from `.github/workflows/`. The App can write `CODEOWNERS`, other `.github/` files and the tier map, and this rule covers those. It applies to every bot, so a Dependabot PR that touches `.github/` needs a human to re-author it.
- **The check fails closed.** A tier map it can't parse, an API error, or a PR over GitHub's 3,000-file listing limit all fail the check.

Known limit: until the planning agent has its own identity (spec 0001, build order step 3), an approval from the approver's login may have come from the planning agent.

### Calling it

The caller (written by bootstrap in #16) triggers on PR updates and on reviews, so an approval re-runs the check:

```yaml
on:
  pull_request:
    types: [opened, synchronize, reopened, edited]
  pull_request_review:
    types: [submitted, dismissed]

jobs:
  tier:
    uses: danjamk/secure-agent-workflow/.github/workflows/tier-check.yml@<commit-sha>
    permissions:
      contents: read
      pull-requests: read
    # with:
    #   approver: someone-else      # default: the repo owner
    #   tier-map: path/to/map.yml   # default: standards/tier-map.yml
```

The required check is the job `tier / tier-check`. The workflow checks out this repo at `job.workflow_sha` (the SHA the caller pinned) and runs nothing from the PR. It needs only the Python standard library.

### Tests

```bash
python3 -m unittest discover -s gate
```

The tests cover tier map parsing, glob matching, classification and every approval rule. They also run `main()` against a stubbed API: a PR that rewrites the tier map is judged by the base map, and a rename out of a tier 3 path is tier 3.

### Live results

2026-10-30, `tier_check.py` run locally against PRs the agent App opened on `danjamk/agent-testbed`. The repo had no tier map, so the default was used:

| PR | Paths | Approval | Result |
| --- | --- | --- | --- |
| Tier 1 | `docs/tier-test.md` | None | Passed |
| Tier 2 | `package.json` | None | Failed: waiting for approval |
| Tier 2 | `tools/package.json` | Owner, on head commit | Passed |
| Tier 2, after the agent pushed again | `tools/package.json` | Owner, on the previous commit | Failed: approval on an old commit |
| Tier 3 | `CODEOWNERS`, `docs/CODEOWNERS` | None, then owner | Failed both times: bot author |

Not yet tested end to end: the reusable workflow running in Actions on a consumer repo, the re-run on `pull_request_review`, and the result as a required check. That needs the caller workflow bootstrap installs in #16.

## Other options for a fork

| Option | Trade-off |
| --- | --- |
| policy-bot (Palantir) | Mature and path-aware, but a service you host (ADR-003) |
| CODEOWNERS with required code-owner review | Can't express "no approval needed" for tier 1 |
| Ruleset approval count | Can't vary by path. On an org, required reviewers per path need teams |
| A different approver | Pass `approver:`. One login; a team or list would be a change to `decide()` |
