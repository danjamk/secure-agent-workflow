# ADR-001: Build agents act as a GitHub App

Status: Accepted · Date: 2026-10-30

## Context

The agent needs to push branches, open PRs and comment on issues. Whatever identity it uses decides what a compromised or confused agent can do, and who can approve its work. GitHub doesn't count an approval from a PR's author.

## Decision

Agents act as a GitHub App owned by `danjamk`, installed per repo, with `contents`, `pull_requests` and `issues` write and `checks` and `metadata` read. The App has no `workflows` and no `administration` permission. The orchestrator mints a short-lived installation token per run; the App's private key never enters the sandbox.

## Alternatives considered

- **Dan's personal token or account.** Dan is admin on his repos, so the agent could edit rulesets and settings. Dan would also be the PR author and couldn't approve agent PRs.
- **A second "machine" GitHub account.** Works, but it's another account to manage, and its PAT is long-lived.
- **Claude Code cloud's GitHub connection.** Acts as whichever GitHub user is connected, which is the first alternative's problem again.

## Consequences

- GitHub rejects any push from the agent that creates or changes a file in `.github/workflows/`, without needing push rulesets.
- Agent PRs are authored by the App's bot, so Dan can approve tier 2 and 3 PRs.
