# Planning agent identity: research notes

Researched 2026-10-30 for spec 0001 and ADR-001. Docs read on that date. Nothing here was tested against a live repo.

## Recommendation

1. Later fix: give the planning agent a machine user account (for example `danjamk-planner`), connect it to Claude Code cloud with `/web-setup`, and make the tier check accept approvals only from the login `danjamk`. This is the only option found that keeps cloud sessions working and stops the planning agent from producing an approval the tier check accepts.
2. Do now, whatever the identity: the tier check must match the reviewer login (`danjamk`, type `User`) on a review whose `commit_id` is the PR head SHA. It must not count approvals through the ruleset's "required approvals" setting, because GitHub App and machine-user approvals likely count there.
3. GitHub cannot tell a review Dan submits in the browser apart from one the Claude GitHub App submits on his behalf. A tier check rule that rejects approvals "made via the Claude App" cannot be built.

## Findings

### 1. How Claude Code cloud sessions get GitHub access

| Finding | Confidence | Source |
| --- | --- | --- |
| There are two connection methods. (a) Browser: "Sign in with GitHub" authorizes the Claude GitHub App, and private repos also need the App installed. (b) `/web-setup`: sends the token printed by `gh auth token` to Anthropic, and sessions then reach any repo that token can reach, without the App installed. | High | [1], [2] |
| The browser method gives a GitHub App user access token (user-to-server). GitHub attributes its API actions to the user, and its abilities are the overlap of the App's permissions and the user's rights. | High for the attribution rule [4]. Medium that Anthropic's browser flow issues this token type: it is inferred from "authorize the Claude GitHub App", and the docs only say the proxy uses "your actual GitHub token". | [1], [3], [4] |
| The Claude GitHub App requests Contents RW, Pull requests RW, Issues RW, Discussions RW, Workflows RW, Actions R and Checks R. It does not request Administration or Deployments. Acting as Dan, the token can therefore approve PRs, merge PRs, push to `.github/workflows/`, and comment. It cannot edit rulesets or approve pending deployments. | Medium. The list comes from Anthropic's claude-code-action `security.md`. The App's public page doesn't list permissions, and I did not see the install screen. | [5], [6], [7] |
| Credentials stay outside the VM. The GitHub proxy swaps a scoped credential for Dan's real token. `GH_TOKEN` and `GITHUB_TOKEN` read as the placeholder `proxy-injected`. | High | [3] |
| The proxy rejects branch deletion and tag pushes. It does not limit which branches a push can update. It limits API calls to the repos attached to the session. | High | [3] |
| The proxy blocks GraphQL with a 403, so `gh pr review`, `gh pr merge` and every other `gh pr` or `gh issue` subcommand fails. The REST equivalents are still reachable through `gh api`: `POST /repos/{o}/{r}/pulls/{n}/reviews` with `event=APPROVE`, and `PUT /repos/{o}/{r}/pulls/{n}/merge`. Enabling auto-merge exists only in GraphQL (`enablePullRequestAutoMerge`), so a cloud session cannot turn on auto-merge. | High for the documented GraphQL block and the REST endpoint list (checked in GitHub's OpenAPI and GraphQL schema). Not tested end to end. | [3], [8] |
| A cloud session can't run under another identity or with fewer rights through any Anthropic setting. The only levers are (a) the GitHub account behind the connection, chosen through the browser sign-in or `/web-setup`, and (b) which repos the Claude App installation covers. Cloud sessions require a connected GitHub account. | High for the documented levers. Medium that no other lever exists, since this rests on finding none in the docs. | [1], [2] |
| `/web-setup` replaces the browser connection for all of that claude.ai account's cloud sessions. To disconnect, go to claude.ai/customize/connectors. | High | [2] |
| You can set your own `GH_TOKEN` or `GITHUB_TOKEN` as an environment variable. It "passes through to the container unchanged" and anyone using the environment can read it. This does not remove Dan's connection. The built-in GitHub tools and git pushes still go through the proxy with the connected account, and an agent can unset the variable to fall back to the proxy. | High that the variable passes through [3]. Medium that git and the built-in tools keep using the connected account, which is inferred from the proxy description. | [3] |
| Network allowlist: the levels are None, Trusted, Full and Custom. GitHub traffic goes through the GitHub proxy and is not subject to the allowlist at any level. You cannot cut GitHub access off with the allowlist. Network secrets are never attached to GitHub requests. | High | [3] |
| claude.ai chat (the normal UI): the built-in "GitHub Integration" only reads file names and contents. It does not see PRs or issues and has no write tools. It is the same connection that cloud sessions use. | High | [9], [2] |

### 2. Telling Dan's browser review apart from an App user-token review

| Finding | Confidence | Source |
| --- | --- | --- |
| REST review object fields: `id, node_id, user, body, state, html_url, pull_request_url, _links, submitted_at, commit_id, body_html, body_text, author_association`. There is no `performed_via_github_app`. | High (checked in GitHub's OpenAPI description) | [8], [10] |
| The `pull_request_review` webhook `review` object has no app field either. The payload's `installation` field names the App that receives the webhook, not the actor's client. `sender` is Dan in both cases. | High (OpenAPI webhook schemas) | [8], [11] |
| The GraphQL `PullRequestReview` type has no `viaApp` or equivalent field. `onBehalfOf` refers to org teams. | High (octokit GraphQL schema) | [12] |
| `performed_via_github_app` exists on issue comments, issues, deployments and some issue timeline events. It does not exist on reviews, on the timeline `reviewed` event, or on `merged_by`. `auto_merge.enabled_by` is a user. | High | [8] |
| GitHub says user-token actions are "attributed to that user". Comments show an app badge in the UI, and audit logs record the token type. Personal account security logs contain no `pull_request_review` or `pull_request.merge` events. Org audit logs have token fields, but Dan has no org. | High for docs. I did not check whether the web UI shows a "via" badge on reviews. | [4], [13] |
| Conclusion: the tier check cannot reject approvals made via a specific App on Dan's account. The only data the API exposes are the reviewer login and the review's `commit_id` and time. | High | — |

### 3. Giving the planning agent its own identity

| Finding | Confidence | Source |
| --- | --- | --- |
| Fine-grained permissions: create PR needs `pull_requests: write`. Create or submit a review (including approve) needs `pull_requests: write`. Merge needs `contents: write`. Create an issue or comment on one needs `issues: write`. Rulesets need `administration: write`. Approving pending deployments needs `deployments: write`. The same rules apply to GitHub Apps (UAT and IAT). | High | [7], [14] |
| No permission combination allows "open PRs" but blocks "approve PRs". Both need `pull_requests: write`. The combination `contents: write` + `issues: write` + `pull_requests: read` can push branches, open issues and comment on issues, and cannot open PRs or approve. It can still call the merge endpoint, which the rulesets and tier check would then block. | High | [7], [14] |
| On a personal account repo, collaborators get one fixed level, write. They can push, "create, merge, and close pull requests" and submit reviews that affect mergeability. They cannot manage settings. The owner can't give a collaborator read or triage. | High | [15] |
| Fine-grained PATs list "contribute to repositories where the user is an outside or repository collaborator" as a limitation. A machine user working on Dan's repos therefore needs a classic PAT or a `gh auth login` OAuth token. That token has broad scopes, but the account's rights are only collaborator-write on the repos it's invited to. | Medium-high. The docs say "repository collaborator" without naming personal-account repos specifically. | [16] |
| GitHub ToS: "You may maintain no more than one free machine account in addition to your free Personal Account." It must be used only for automated tasks, and the human owner is responsible. A planning-agent machine user is allowed. | High | [17] |
| A second GitHub App for the planning agent doesn't plug into cloud sessions. The connection takes either the Claude App user token or a `gh` token. An App installation token (1 hour lifetime) could only go in `GH_TOKEN`, where Dan's connection is still reachable (see section 1). | Medium (inference from [2], [3]) | [2], [3] |

### 4. Do App or bot approvals count toward required approvals in rulesets?

The spec's platform table says "Bot approvals counting toward reviews: No" for both public and private repos. The evidence says this is probably wrong for GitHub Apps and machine users.

| Finding | Confidence | Source |
| --- | --- | --- |
| GitHub docs say approvals count when they come from "people with write or admin permissions". Copilot approvals do not count. The docs say nothing about other Apps. | High | [18], [19] |
| Renovate's docs say its `renovate-approve` GitHub Apps "mark all automerging Pull Requests by Renovate as approved", which satisfies mandatory reviews. This shows a GitHub App's approval counting. | Medium-high. It's vendor docs, not GitHub's, and it doesn't say whether the repo is personal or org-owned. | [20] |
| GitHub's 2022 changelog added "Allow GitHub Actions reviews to count towards required approval". That setting exists because Actions approvals did count. A 2025–2026 community thread reports `github-actions[bot]` approvals not counting, and App or machine-user approvals counting. No GitHub staff answered. | Medium | [21], [22] |
| PR authors can't approve their own PRs. This holds for the build App on its own PRs. | High | [18] |
| Impact: the design is still safe as long as the tier check checks the reviewer's login. If the merge gate relied on the ruleset's "required approvals" count, any second App or a machine user with write access could satisfy it. That includes the Claude App installation (as `claude[bot]`) and a planning machine user. | Medium (depends on the rows above) | — |

Live test, 2026-10-30 (`bootstrap/github-app/verify.sh`, public and private testbeds on personal Pro): a second App with `pull_requests: write` and no `contents` permission approved a build-App PR. The approval was recorded, but the PR's `reviewDecision` stayed `REVIEW_REQUIRED` under a one-approval ruleset. So an App's approval did not count in this setup. An App with `contents: write` was not tested. The conclusion for the tier check stands: check the reviewer's login, not the approval count.

### 5. Other controls and where they are enforced

| Control | Enforced | What it does here | Confidence | Source |
| --- | --- | --- | --- | --- |
| Ruleset bypass list | Server (GitHub) | Bypass actors can be the repo admin role, write or maintain roles, teams, Apps, or Dependabot, in "Always" or "For pull requests only" mode. Keep the admin role and Dan off the bypass list for `main`. If admin can bypass, the planning agent acting as Dan can merge past the tier check through REST. I could not confirm in the docs that admins are subject to rulesets by default. My understanding is that they are unless listed, which differs from classic branch protection. | Medium | [23], [24] |
| Tier check matching reviewer login and `commit_id` | Server (required status check) | Stops the build App, other Apps and a machine user from satisfying tier 2/3. Does not stop an agent acting as Dan. | High | [8] |
| CODEOWNERS with "Require review from Code Owners" | Server | Requires a code owner's approval. If Dan is the code owner, an agent acting as Dan still satisfies it. Apps can't be listed as CODEOWNERS. Path-based required reviewers need teams, which personal repos don't have. | High | [19], [20] |
| Environment required reviewers | Server | Public repos only on personal Pro (per spec). Approving needs `deployments: write`, which the Claude App doesn't request. A gate job behind a `tier-approval` environment with Dan as reviewer would be out of reach of a browser-connected cloud session. It would not be out of reach of a `/web-setup` classic token. | Medium (depends on the App permission list) | [7], [14] |
| GitHub remote MCP server tool filtering (`X-MCP-Tools`, `X-MCP-Toolsets`, `/readonly`, `/x/{toolset}`) | Server (GitHub's MCP server) | For planning in the claude.ai chat UI: expose `issue_write`, `add_issue_comment`, `create_pull_request` and file tools, but not `pull_request_review_write` or `merge_pull_request`. The token underneath is still Dan's, but the model only reaches it through the listed tools. claude.ai can also mark individual connector tools **Blocked**. Header-based config in claude.ai custom connectors is a limited beta. | Medium | [25], [26] |
| Claude Code permission deny rules and hooks (`.claude/settings.json`) | Client (the Claude Code process inside the VM) | Weak. On Pro or Max, the only settings that reach a cloud session are the repo's `.claude/settings.json`, which the agent can edit and Claude Code reloads on change. Bash deny patterns can be avoided with curl or python. Server-managed settings need a Team or Enterprise org. | High | [27], [3] |
| Cloud environment network level | Anthropic proxy | Doesn't apply to GitHub traffic. | High | [3] |
| Signed approval (an option, not an existing feature) | Server (tier check verifies) | Dan approves with a local command. It signs `repo#PR@headSHA` with a hardware-backed SSH key (`sk-ssh-ed25519`, touch required) and posts it as the review body. The tier check verifies the signature against `GET /users/danjamk/ssh_signing_keys`. This works whatever identity the planning agent holds. The cost is custom code, and one terminal command instead of a browser click. | Medium (design idea, not tested) | — |

## Options table

| Option | What it blocks | Setup cost | Works with Claude Code cloud? |
| --- | --- | --- | --- |
| **A. Accept: planning agent is Dan via the Claude App (current)** | Ruleset edits and settings changes (no Administration permission). Auto-merge (GraphQL blocked). It does not block approve, merge, or workflow-file pushes as Dan. | None | Yes |
| **B. Machine user + `/web-setup` (recommended later fix)** | The tier check ignores its approvals. It has no admin or ruleset rights. It can still merge tier 1 PRs (the gate allows that anyway) and push non-protected branches. | Medium. Second account with 2FA, invited as a collaborator per repo, classic or `gh` token. `/web-setup` switches all of Dan's cloud sessions to that account. Variant: a second claude.ai account keeps Dan's own connection but costs another subscription. | Yes |
| C. Dan's own token with `pull_requests: read` via `/web-setup` (fine-grained PAT) | Approvals and PR creation. Not merges (`contents: write`). | Low | Partly. The agent can't open PRs. Whether `/web-setup` accepts a fine-grained PAT is not verified. |
| D. `GH_TOKEN` env var with a limited or other-identity token | Nothing reliable. Dan's connection stays reachable through the proxy and built-in tools. | Low | Yes, but ineffective |
| E. Tier check rejects approvals "via Claude App" | Not buildable: reviews carry no app attribution. | — | — |
| F. Signed approvals (hardware SSH key) in the tier check | Any approval not signed by Dan's key, whatever the GitHub identity | Medium-high (custom CLI and verifier) | Yes |
| G. Environment required reviewer as the approval channel | Approval through the Claude App connection (no Deployments permission) | Low-medium | Yes, public repos only |
| H. Plan in claude.ai chat with a filtered GitHub MCP connector | Review and merge tools are not exposed | Low-medium | No. Chat UI only. Cloud sessions still have the full proxy. |
| I. Claude Code deny rules or hooks | Accidental approve or merge commands only | Low | Yes, but client-side and agent-editable |

## Unverified

- The Claude GitHub App's permission list as shown on the install screen. I used Anthropic's `claude-code-action` `security.md`, which may lag behind the live App.
- That the browser connection's token is a GitHub App user access token, as opposed to some other token Anthropic holds.
- Whether the built-in GitHub tools in cloud sessions include approve or merge actions. The docs list read issues, list PRs, fetch diffs and post comments.
- Whether an explicit `GH_TOKEN` overrides the proxy's credential on `gh api` calls, or whether git pushes ever use it.
- Whether `/web-setup` accepts a fine-grained PAT stored in `gh`.
- Whether GitHub App approvals count toward ruleset required approvals on a personal Pro repo. Evidence leans yes, but no GitHub doc states it.
- Whether repo admins are subject to rulesets unless they are on the bypass list.
- Whether the GitHub web UI shows a "via App" badge on reviews (not usable by the tier check either way).
- Whether claude.ai custom connectors on Pro or Max can send the `X-MCP-Tools` header (request headers are a limited beta).

## Effects on the build agent

These apply now, independent of the planning agent:

- Spec tier 3 says "Human-authored, Dan approves", but GitHub doesn't let Dan approve his own PR. The tier check treats a PR authored by the approver login as approved. That is a second path for a planning agent acting as Dan, covered by the same accepted risk.
- The Claude App connection can push to `.github/workflows/` as Dan (Workflows RW), so the "no workflows permission" control covers only the build App.
- The build agent enables auto-merge, which is GraphQL-only. The outbound handler must allow `api.github.com/graphql` and filter by mutation name.

## Sources

1. [Use Claude Code in the cloud](https://code.claude.com/docs/en/claude-code-on-the-web)
2. [Get started with Claude Code in the cloud (web quickstart)](https://code.claude.com/docs/en/web-quickstart)
3. [Configure cloud environments: GitHub proxy, network access, GH_TOKEN](https://code.claude.com/docs/en/cloud-environments)
4. [Authenticating with a GitHub App on behalf of a user](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/authenticating-with-a-github-app-on-behalf-of-a-user)
5. [claude-code-action security.md: Claude GitHub App permissions](https://github.com/anthropics/claude-code-action/blob/main/docs/security.md)
6. [Claude GitHub App page](https://github.com/apps/claude)
7. [Permissions required for GitHub Apps](https://docs.github.com/en/rest/authentication/permissions-required-for-github-apps)
8. [GitHub REST OpenAPI description (api.github.com.json)](https://github.com/github/rest-api-description)
9. [Claude GitHub integration (chat)](https://claude.com/docs/connectors/github)
10. [REST API: pull request reviews](https://docs.github.com/en/rest/pulls/reviews?apiVersion=2022-11-28)
11. [Webhook events and payloads](https://docs.github.com/en/webhooks/webhook-events-and-payloads#pull_request_review)
12. [octokit/graphql-schema](https://github.com/octokit/graphql-schema)
13. [Security log events (personal account)](https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/security-log-events)
14. [Permissions required for fine-grained personal access tokens](https://docs.github.com/en/rest/authentication/permissions-required-for-fine-grained-personal-access-tokens)
15. [Permission levels for a personal account repository](https://docs.github.com/en/account-and-profile/reference/permission-levels-for-a-personal-account-repository)
16. [Managing your personal access tokens](https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/managing-your-personal-access-tokens)
17. [GitHub Terms of Service, B.3 Account requirements](https://docs.github.com/en/site-policy/github-terms/github-terms-of-service)
18. [Approving a pull request with required reviews](https://docs.github.com/en/pull-requests/how-tos/review-pull-requests/approving-a-pull-request-with-required-reviews)
19. [Available rules for rulesets](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-rulesets/available-rules-for-rulesets)
20. [Renovate automerge: required pull request reviews](https://docs.renovatebot.com/key-concepts/automerge/)
21. [GitHub changelog 2022-01-13: prevent GitHub Actions from approving pull requests](https://github.blog/changelog/2022-01-13-github-actions-prevent-github-actions-from-approving-pull-requests)
22. [Community discussion #181487: GHA bot review not affecting merge requirements](https://github.com/orgs/community/discussions/181487)
23. [Creating rulesets for a repository (bypass)](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-rulesets/creating-rulesets-for-a-repository)
24. [About rulesets](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-rulesets/about-rulesets)
25. [GitHub MCP server: remote server configuration](https://github.com/github/github-mcp-server/blob/main/docs/remote-server.md)
26. [Claude: add a custom connector (request headers, tool blocking)](https://claude.com/docs/connectors/custom/add-unlisted)
27. [Claude Code settings: settings in cloud sessions](https://code.claude.com/docs/en/settings)
