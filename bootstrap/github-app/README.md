# Agent GitHub App

The build agent acts as a GitHub App, not as a person (ADR-001). The App's permissions are the control: it can push branches, open PRs and comment, and it cannot change workflows, rulesets or repo settings.

| File | What it does |
| --- | --- |
| `build-agent.manifest.json` | The build agent App: permissions and events |
| `testbed-reviewer.manifest.json` | A throwaway App used only by `verify.sh` to test whether App approvals count toward rulesets |
| `create-app.py` | Creates an App from a manifest through GitHub's manifest flow and stores its credentials in the macOS Keychain |
| `mint-token.sh` | Mints a 1-hour installation token for one repo, for local testing |
| `verify.sh` | Checks against a testbed that the App can do its job and nothing more |
| `testbed-ruleset.json` | Temporary ruleset `verify.sh` applies to the testbed and removes afterward |

## Permissions

| Permission | Level | Why |
| --- | --- | --- |
| `contents` | write | Push `agent/*` branches |
| `pull_requests` | write | Open PRs, mark them ready |
| `issues` | write | Comment, add `agent:blocked` |
| `checks` | read | Read gate results |
| `metadata` | read | Required by GitHub |
| `workflows` | none | GitHub then rejects any push that touches `.github/workflows/` |
| `administration` | none | No access to rulesets or repo settings |

Events: `issues` (release and stop labels), `issue_comment` (Dan's replies resume a blocked run), `pull_request` (the coordinator watches for conflicts). The webhook stays inactive until the orchestrator exists.

`pull_requests: write` also allows submitting reviews. That is harmless for the build agent: GitHub doesn't let an author approve its own PR, the outbound handler blocks the reviews endpoint, and the tier check accepts approvals only from Dan's login.

## Setup

```bash
# 1. Create the App. Opens a browser; click "Create GitHub App".
python3 bootstrap/github-app/create-app.py bootstrap/github-app/build-agent.manifest.json

# 2. Install it on the repos the agent may work in, from the URL the script prints.

# 3. Mint a token to check it works.
bash bootstrap/github-app/mint-token.sh danjamk-build-agent <owner>/<repo>
```

`create-app.py` stores three Keychain items under service `secure-agent-workflow`, account `<slug>:<item>`: `app-id`, `private-key` (the PEM, base64-encoded) and `webhook-secret`. Nothing secret is written to disk or printed. When the orchestrator exists, the private key and webhook secret move to Worker secrets.

App names are unique across GitHub. A fork changes `name` in the manifest.

## Contract with the orchestrator

The orchestrator needs three things from this folder:

| Item | Where it lives in production |
| --- | --- |
| App id | Worker variable |
| Private key | Worker secret. Never enters the sandbox |
| Webhook secret | Worker secret |

The orchestrator mints one installation token per run, scoped to the one repo, with a 1-hour lifetime. `mint-token.sh` does the same thing locally and is not the production path.

## Verification

```bash
bash bootstrap/github-app/verify.sh danjamk/agent-testbed
bash bootstrap/github-app/verify.sh danjamk/agent-testbed-private
```

Results, 2026-10-30, both testbeds (public and private, personal Pro): all expectations held.

| Check | Public | Private |
| --- | --- | --- |
| Push an `agent/*` branch | Allowed | Allowed |
| Open a PR | Allowed | Allowed |
| Comment on an issue or PR | Allowed | Allowed |
| Enable auto-merge (GraphQL) | Allowed | Allowed |
| Push a `.github/workflows/` file | Blocked | Blocked |
| Create or edit a ruleset | Blocked | Blocked |
| Create a check run | Blocked | Blocked |
| Create a commit status | Blocked | Blocked |
| Read rulesets | Allowed | Allowed |
| Second App's approval counts toward the ruleset | No (`REVIEW_REQUIRED`) | No (`REVIEW_REQUIRED`) |

Notes:

- `contents`, `pull_requests` and `issues` write are enough to enable auto-merge.
- Reading rulesets needs only `metadata: read`. That is harmless; editing them is blocked.
- The reviewer App's approval was accepted as a review but did not satisfy a one-approval ruleset. The reviewer App has `pull_requests: write` and no `contents` permission. GitHub counts approvals from accounts with write access, so an App with `contents: write` might still count; that was not tested. The tier check doesn't depend on the answer: it accepts only Dan's login.

## Other options for a fork

| Option | Trade-off |
| --- | --- |
| A GitHub App owned by an organization | Same model. Org rulesets and push rulesets become available on Team |
| A machine user account | One per person under GitHub's terms. Its token is long-lived, and as a collaborator it gets write access with no finer control |
| A fine-grained PAT on a person's account | The agent would act as that person, who could then not approve the agent's PRs |

macOS Keychain is a local convenience. On another OS, replace `store()` in `create-app.py` and `keychain()` in `mint-token.sh`.
