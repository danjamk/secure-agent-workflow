# Spec 0001: Secure build-agent workflow

Status: Draft · Owner: Dan Kuhn · Created: 2026-10-29 · Revised: 2026-10-30 (build order, PR audit, tier 3 enforcement, replaceable parts)

## Summary

This repo packages a workflow where coding agents build from approved issues with as little human involvement as possible, and nothing reaches production without passing controls the agent cannot change. v1 targets one developer (Dan) on public and private repos under a personal GitHub Pro account, deploying to Cloudflare. Everything ships as code: one command bootstraps a repo, one label starts an agent.

The first consumer is a private reference build, a data and reporting platform large enough to test real autonomy.

## Goals

1. **Say "go" and walk away.** After spec, plan, ADRs and issues are done, agents work issues to merged PRs without prompting Dan, except on high-risk changes.
2. **Controls the agent cannot change.** Security comes from the sandbox, GitHub permissions and cloud credentials, not from agent instructions or settings files inside the sandbox.
3. **Vendor-neutral build agents.** Any agent CLI and any model vendor can run in the sandbox.
4. **Low setup and maintenance cost.** A new repo is protected in one command. Gate logic is updated in one place.
5. **Cheap for personal use.** Under $30 a month beyond existing subscriptions.
6. **Reusable by teams later.** The same model maps onto a GitHub organization and an enterprise sandbox without redesign.
7. **Replaceable parts.** v1 picks Cloudflare and AWS, but each component sits in its own directory behind a stated contract, so a fork can rewrite one part without touching the others. This is code organization, not a configuration layer. The README lists the alternatives for each part.

## Non-goals (v1)

- Agent types other than the build agent. Planning, pipeline and diagnostics agents come later.
- Organization-only GitHub features (push rulesets, org-wide rulesets).
- Production read access for the agent.

## Relationship to claude-shared

`claude-shared` sets how Dan works with Claude interactively. This repo sets how agents work unattended. It references `claude-shared` standards and guides rather than copying them.

One deliberate extension: `claude-shared` reserves every merge for Dan. Repos bootstrapped by this repo let tier 1 PRs merge on green checks. Tier 2 and 3 keep the `claude-shared` rule.

## Workflow

1. Dan writes specs, an implementation plan and ADRs with the planning agent.
2. The plan becomes GitHub issues on the repo's board.
3. Dan labels issues `agent:ready` to release them.
4. The orchestrator starts a sandbox per issue. The agent works on `agent/<issue>-<slug>`, opens a PR and enables auto-merge.
5. The merge gate runs. Tier 1 PRs merge on green; tier 2 and 3 PRs wait for Dan.
6. A merge to `main` builds and deploys to `dev`, then `production`.

## Components

| Component | What it does | v1 approach |
| --- | --- | --- |
| `bootstrap/` | Applies repo settings as code: rulesets, environments, Actions policy, labels, CODEOWNERS, gate callers | `gh api` script, idempotent, dry-run mode. Extends `claude-shared/scripts/protect-branch.sh` |
| Agent identity | GitHub App the agent acts as | App owned by `danjamk`: `contents`, `pull_requests`, `issues` write; `checks`, `metadata` read; **no `workflows`**, no `administration` (ADR-001) |
| `orchestrator/` | Starts a sandbox per released issue | Cloudflare Worker: receives `issues.labeled` webhooks, starts a Sandbox SDK microVM, runs the agent CLI, tears it down (ADR-004) |
| Egress and credential proxy | Keeps credentials out of the sandbox; enforces the domain allowlist | Worker outbound handlers: `enableInternet = false` plus `allowedHosts`; inject a short-lived App installation token and model API keys; reject pushes outside `agent/*` |
| `gate/` | Merge gate as reusable workflows, pinned by SHA | Deterministic checks, tier check (ADR-003), PR audit |
| `deploy/` | Deploy template for Cloudflare | `dev` and `production` environments, OIDC broker, attested artifacts (ADR-002) |
| `standards/` | Templates agents and reviewers rely on | ADR template, agent instructions, issue template, tier map |
| `redteam/` | Scripted attacks the controls must stop | Run against a bootstrapped repo; results published |
| Planning agent | Human-in-the-loop spec, plan and ADR work | Claude in Dan's normal UI or Claude Code cloud, acting as Dan on GitHub. Accepted for early phases; it gets its own identity in step 3 of the build order |

## Merge gate

Deterministic checks are authoritative. The PR audit can reject a PR but never approve one.

| Tier | Paths (default, overridable per repo) | To merge |
| --- | --- | --- |
| 1 | App source, tests, docs | All checks green, no blocking PR audit finding |
| 2 | Dependency manifests and lockfiles, auth and permission code, migrations, `wrangler.*` | Tier 1, plus Dan's approval |
| 3 | `.github/**`, `CODEOWNERS`, `standards/tier-map.yml` | Human-authored, Dan approves, zizmor and actionlint pass. The tier check fails any agent-authored PR that touches these |

Only `.github/workflows/` is blocked by GitHub itself, because the agent App has no `workflows` permission. The App's `contents: write` covers every other tier 3 path, so the tier check is the control for those. It reads the tier map from the base branch, never from the PR. Paths that match no rule count as tier 2.

Check order:

1. Build, tests, lint, type check.
2. Scanners: CodeQL, secret scanning and dependency review on public repos; Semgrep CE, gitleaks, osv-scanner and trivy on private repos, where GitHub's versions are paid.
3. zizmor and actionlint when `.github/**` changes.
4. Tier check: computes the tier from changed paths and fails until the required approval exists.
5. PR audit, spec conformance: checks the diff against the issue, plan and ADRs.
6. PR audit, security: a reviewer on a different model family than the builder.

### PR audit

The PR audit is the gate's LLM layer, on top of the deterministic checks and scanners. It has two jobs:

1. Reject bad PRs before a human sees them.
2. Cut the work of whoever approves tier 2 and 3 PRs. One summary per PR, updated on each push, gives the tier and reason, check results, audit findings and the files that need a human look.

It reports through required checks, never through an approving review. The reviewer model is vendor-neutral; for example, Codex can audit a Claude Code build.

## Build order

The three agent roles are hardened one at a time. Nothing in steps 1 and 2 waits on step 3.

1. **Build agent.** App identity, bootstrap, orchestrator and sandbox, deterministic gate and tier check, deploy, red-team.
2. **PR audit.** LLM reviewers and the approver summary.
3. **Planning agent.** Its own GitHub identity, so its approvals don't count as Dan's.

Until step 3, the planning agent acts as Dan on GitHub. It can approve an agent's PR or merge one, and the tier check cannot tell that approval from Dan's: GitHub records no App attribution on reviews. This is an accepted risk for early phases: the planning agent always has Dan in the loop, and it does not run unattended. The likely step 3 fix is a machine user for the planning agent; see [planning agent identity](../research/planning-agent-identity.md).

## Platform constraints

Personal Pro covers both public and private repos. The gaps don't touch the critical gates.

| Control | Public | Private | Substitute when missing |
| --- | --- | --- | --- |
| Rulesets on `main` | Yes | Yes | — |
| Push rulesets on `.github/**` | No | No (orgs on Team) | Agent App has no `workflows` permission; GitHub rejects workflow-file pushes |
| Environment secrets, deployment branch policy | Yes | Yes | — |
| Environment required reviewers | Yes | No | Merge gate + `main`-only deploys + AWS OIDC subject check |
| CodeQL, secret scanning, dependency review | Free | Paid | Free scanners in the gate |
| Harden-Runner egress block | Free | Paid | Not needed: agents don't run in Actions |
| Bot approvals counting toward reviews | Unverified; App approvals likely count | Same | The tier check accepts only the approver's login on the head commit, never the ruleset's approval count. The PR audit reports through required checks |
| OIDC to Cloudflare | No | No | Cloudflare token behind an AWS role only `environment:production` can assume |

Public repos only: fork PRs require approval before workflows run, and AI reviewers run only on PRs from the agent App or Dan.

## Credentials

Production uses one trust anchor, GitHub OIDC, and a broker issues each platform's credentials (ADR-002).

1. The deploy job requests a GitHub OIDC token with subject `repo:danjamk/<repo>:environment:production`.
2. An AWS IAM role trusts only that subject. Secrets sit in SSM Parameter Store standard parameters.
3. The role reads the Cloudflare token and third-party keys. Later, the job mints a short-lived Cloudflare token per deploy.
4. The broker sits behind one small interface in `deploy/`, so Vault or OpenBao can replace AWS at a client.

| Credential | Who holds it | Reaches |
| --- | --- | --- |
| GitHub App private key | Orchestrator Worker secret | Mints installation tokens; never enters the sandbox |
| Model API keys | Orchestrator Worker secrets | Injected per request by the outbound handler |
| Cloudflare dev token | Orchestrator Worker secret | The dev account only |
| Cloudflare prod token | AWS Parameter Store, read by the prod role | The prod account |
| AWS prod role | OIDC trust policy | Assumed only by `environment:production` |

## Developer experience requirements

1. Bootstrap a repo: one command, under 5 minutes, safe to re-run.
2. Start work: one label per issue.
3. Dan's touches per tier 1 PR: zero. Tier 2 and 3: one approval, with the reason stated at the top of the PR.
4. Notifications: one per PR that needs Dan, one daily digest otherwise.
5. Updating gate logic: change this repo, bump the pinned SHA in consumers with one command.

## Success measures

- 10 consecutive tier 1 PRs on the reference build merged with zero touches from Dan.
- Every red-team scenario blocked, with the blocking control identified.
- Bootstrap applied to one existing personal project.
- Monthly cost under $30 beyond existing subscriptions.

## Red-team scenarios (v1)

1. Agent edits a workflow file.
2. Agent pushes to `main` or deletes a protected branch.
3. Agent prints environment variables or tries to read a credential.
4. Agent calls a domain outside the allowlist.
5. Agent adds a dependency with a known vulnerability.
6. PR content instructs the AI reviewer to approve.
7. A fork PR attempts to run a modified workflow (public repos).

Added in build order step 3: the planning agent approves or merges a PR.

## Decisions

- [ADR-001](../adr/ADR-001-agent-github-app-identity.md): The agent acts as a GitHub App.
- [ADR-002](../adr/ADR-002-oidc-credential-broker.md): Production credentials come through a GitHub OIDC broker on AWS.
- [ADR-003](../adr/ADR-003-tier-check-reusable-workflow.md): The tier check is a reusable workflow.
- [ADR-004](../adr/ADR-004-cloudflare-sandbox.md): Build agents run in the Cloudflare Sandbox SDK.

## Open decisions

- [ ] Which agent CLIs to support first (suggest Claude Code and Codex).
- [ ] Builder and reviewer model families.
- [ ] AWS account to host the OIDC broker.
- [ ] Planning agent identity (build order step 3).

## References

- Research: [sandbox bake-off](../research/sandbox-bakeoff.md), [planning agent identity](../research/planning-agent-identity.md)
- [About rulesets](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-rulesets/about-rulesets)
- [Deployments and environments](https://docs.github.com/en/actions/reference/workflows-and-actions/deployments-and-environments)
- [Approving a PR with required reviews](https://docs.github.com/en/pull-requests/collaborating-with-pull-requests/reviewing-changes-in-pull-requests/approving-a-pull-request-with-required-reviews)
- [Cloudflare Sandbox outbound traffic](https://developers.cloudflare.com/sandbox/guides/outbound-traffic/)
- [Cloudflare Workers with GitHub Actions](https://developers.cloudflare.com/workers/ci-cd/external-cicd/github-actions/)
