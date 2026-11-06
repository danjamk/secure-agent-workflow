# Orchestrator

A Cloudflare Worker in the factory account that starts a sandbox per released issue (ADR-004). It's built in steps, and this is what exists today:

| Built | Not built yet |
| --- | --- |
| `/health`, webhook intake, the release checks, delivery dedupe, installation tokens, the outbound policy, a container per run that runs Claude Code or the outbound probe, one status comment per run | Logs (#10), stop and resume (#11), the coordinator (#13) |

## A run

An accepted release starts a run, named by the delivery id. An issue has one active run at a time, so relabeling while a run is live doesn't start a second. A runner module (`src/agents/`) decides what the run does:

| Runner | Picked when | What it runs |
| --- | --- | --- |
| `claude-code` | By default | Claude Code 2.1.309, headless, as the `agent` user on a `standard-1` instance. Limited to 60 minutes, 200 turns and its own $5 estimate |
| `probe` | The issue also has `agent:probe` | `container/probe.sh`, which tries what an agent might and reports what got through (#79). Use it to recheck the policy after changing it. Limited to 12 minutes, on a `lite` instance |

Adding an agent CLI is a new module in `src/agents/` and one line in `RUNNERS`.

The `RunState` Durable Object owns the run, and an alarm checks it every 10 seconds:

1. Post the run's status comment on the issue.
2. Register the intercepts, then start the container with `enableInternet: false`.
3. Wait for the platform's CA, which appears once HTTPS is intercepted. Then write the runner's files and start its command. For the agent, the files are the issue's title and body, and `standards/agent-instructions.md`, which is bundled into the Worker. The command's output goes to a file, because a process with piped output gets `SIGPIPE` when the call that started it ends.
4. When the command exits, destroy the container, edit the status comment with the result, release the issue and stop the run, which revokes its token.

Every way out goes through step 4: the command finishing, the container stopping on its own, an error, or the time limit. For the agent, the result is Claude Code's final result event, because it can exit 0 after a failed model request. The output comes from the container, so it's treated as untrusted: credentials are scrubbed, the length is capped and it can't close its code block.

Inside the container:

- `run-agent.sh` clones the repo, sets the App's bot as the commit author and runs Claude Code with a fixed prompt that points at the files. The issue reaches the agent only as a file.
- `agent-gh` makes the GitHub writes the agent needs: open its draft PR, edit it, mark it ready, turn on auto-merge, comment, and add `agent:blocked`. The `gh` CLI isn't installed, because it makes these writes through GraphQL calls the policy refuses.
- Claude Code's web search and web fetch are off, along with its telemetry, error reports, auto-update and feedback, each of which would try a host the container can't reach.
- A repo's own `.claude/settings.json` hooks and `.mcp.json` servers run too, without a prompt. They stay inside the container, and an MCP server can reach only the allowed hosts.

Each probe run leaves a branch, a PR and a comment on the testbed's issue. Remove them by hand.

## Outbound policy

The container starts with `enableInternet: false`, and the run intercepts HTTPS for these hosts only. Every request to them reaches the `Outbound` entrypoint (`src/outbound/handler.ts`), and other names don't resolve, so DNS can't carry data out. There's no plain HTTP intercept. Each request is denied unless a rule below allows it. The stop flag and the HTTPS check come first.

A request to a host that isn't listed fails inside the container and never reaches the Worker, so it isn't logged.

| Host | Allowed | Credential |
| --- | --- | --- |
| `github.com` | Git for this run's repo: `info/refs`, `git-upload-pack`, `git-receive-pack`. A push must be one ref, on the run's branch, and not a deletion | Installation token |
| `api.github.com`, REST | Reads under the run's repo. Writes: create the run's one PR, edit its title and body, comment on its issue or PR, add `agent:blocked` to its issue | Installation token |
| `api.github.com`, GraphQL | Queries. One `markPullRequestReadyForReview` or `enablePullRequestAutoMerge` per request, on the run's PR | Installation token |
| `api.anthropic.com`, `api.openai.com` | The message endpoints, for models in `ALLOWED_MODELS`. No vendor-run tools or URL inputs, because those make the vendor reach another host | The vendor's key. Unset means denied |
| Hosts in `EGRESS_HOSTS` for this repo | GET and HEAD. `github.com` here allows release downloads only | None |

How the rules hold up:

- **Run scope.** The orchestrator passes the run's repo, issue and default branch as the entrypoint's props, which the container can't read or change. The `RunState` Durable Object holds what's set during the run: the stop flag, the branch and the PR. The first ref pushed becomes the branch, and the PR's number and node ID come from GitHub's response.
- **Repo id.** The token is minted for the immutable repo id, so renaming a repo can't point it at another.
- **What's forwarded.** The URL is rebuilt, headers come from a short list, and each write's JSON is rebuilt from what was checked. So `Authorization`, `Cookie`, `X-HTTP-Method-Override`, a repeated JSON key and an encoded path don't reach GitHub.
- **Redirects.** They're never followed. One from a call with a credential comes back as a 502, because its `Location` can hold a signed URL.
- **Force-pushes.** A push's ref commands can't show one, so the `agent-branches` ruleset blocks them (`bootstrap/README.md`).

Known limits:

- A commit message like `Fixes #99` can close another issue when the PR merges. The policy blocks this in PR titles and bodies, and #13 treats a blocker closed by an agent's PR as still open.
- A registry read can carry data in its path. It reaches only the registry's own logs, and the list is per repo for that reason.
- Output ceilings, concurrency and spend are in #11.

## What counts as a release

The Worker acts on a webhook only if all of these hold. Anything else gets a 200 with the reason in the body, which shows in the App's delivery log.

- The `X-Hub-Signature-256` signature matches the raw body.
- The event is `issues.labeled` with the label `agent:ready`.
- The sender is `APPROVER_LOGIN` and is a user account. The agent App has `issues: write`, so it can add this label too; that's ignored (ADR-005).
- The repo is in `ALLOWED_REPOS`.
- The issue is open.
- This delivery id hasn't been accepted before.

An empty `APPROVER_LOGIN` or `ALLOWED_REPOS` means nothing is released, and a missing webhook secret means every webhook gets a 500.

If starting the run fails, the Worker returns a 502 and forgets the delivery id, so redelivering it from the App's delivery log tries again. A failure after that is reported on the issue.

## Contract with the sandbox

#79 and #9 have to keep to this.

| | |
| --- | --- |
| Goes in | The issue's title and body and `standards/agent-instructions.md`, as files in `/workspace/task`, and a clone over HTTPS |
| Comes out | Commits on `agent/<issue>-<slug>`, a PR, issue and PR comments, the `agent:blocked` label, and the run's log |
| Never enters | The App private key, the webhook secret, installation tokens and model API keys. The outbound handler adds tokens and keys to each request |
| Network | Deny by default. HTTPS to the listed hosts reaches the policy. Nothing else resolves or connects |

## Contracts with other components

| Component | What the orchestrator expects |
| --- | --- |
| `bootstrap/github-app/` | An App with the permissions in its README, and its id, private key and webhook secret in the Keychain until `connect-app.sh` copies them |
| `bootstrap/` | The `agent:*` labels and the `agent-branches` ruleset on each repo, and the `factory` environment on this one |
| `deploy/broker/aws/` | The deploy token and settings, through the broker action |
| `standards/agent-instructions.md` | The branch pattern, labels and PR format |
| `gate/` | Nothing directly. The gate judges the PR the agent opens |

## Credentials

| Item | Where it lives | Set by |
| --- | --- | --- |
| `GITHUB_APP_PRIVATE_KEY` | Worker secret, PKCS#8 | `connect-app.sh` |
| `GITHUB_WEBHOOK_SECRET` | Worker secret | `connect-app.sh` |
| `ANTHROPIC_API_KEY` | Worker secret, set in the dashboard: Workers & Pages → `saw-orchestrator` → Settings → Variables and Secrets. Or with `wrangler secret put`. The key is `saw-factory-anthropic-api-key` in the Anthropic Console, expires after 90 days and sits under a monthly spend limit. Nothing reminds you before it expires | The operator, by hand |
| `OPENAI_API_KEY` | Worker secret, optional and not set. A model host with no key is refused | The operator, by hand |
| Installation tokens for runs | In memory in `RunState`, and never in storage. Revoked on stop | Minted on demand, replaced with 10 minutes left |
| `saw-factory-cloudflare-deploy-token` | The broker, read only by the `factory` environment's role | The operator, with `broker.sh set-factory`. This account is never a deploy target for an app, and `broker.sh set` refuses this token |

## Deploying

CI deploys this on merge to `main`, after the owner approves the run. `.github/workflows/orchestrator-deploy.yml` checks that `/health` matches the commit. `deploy/README.md`, Factory deploys, has the setup and which changes start a deploy.

The account, the Worker's URL and the repo list stay out of committed files and out of the logs.

`wrangler deploy` builds `container/Dockerfile` for `linux/amd64` and pushes it to Cloudflare's registry, so it needs Docker. GitHub's Ubuntu runners have it. The deploy token needs Containers Edit for the push. Without it, the first Containers API call fails with no reason given, before the Worker changes.

### Deploying by hand

Two jobs need a token on your machine: setting Worker secrets, which CI never does, and an emergency deploy when CI is down. No long-lived token stays on disk for either.

1. Create a Cloudflare token in the factory account with Workers Scripts Edit, Containers Edit, Account Settings Read and a TTL of one day.
2. Put it in this shell only, from a clean checkout. `.env.local` needs `CLOUDFLARE_ACCOUNT_ID`, `APPROVER_LOGIN`, `ALLOWED_REPOS` and `ORCHESTRATOR_URL`.
3. Run what you need, then revoke the token.

```bash
read -rs CLOUDFLARE_API_TOKEN && export CLOUDFLARE_API_TOKEN
make -C orchestrator connect   # copies secrets, points the App's webhook at the Worker
make -C orchestrator deploy    # emergency only: this skips the approval
make -C orchestrator health    # checks the live Worker matches this checkout
```

Rerun `connect` when the App's private key or webhook secret changes. A new setup also runs `deploy` once by hand first, because `connect` needs the Worker to exist and the first run prints its URL.

## Tests

```bash
make -C orchestrator check           # typecheck and every test
make -C orchestrator test-security   # who can release an issue, and what a run can reach
```

Tests run in the Workers runtime through `@cloudflare/vitest-plugin`, with a real Durable Object. Only GitHub is stubbed. Each run generates its own throwaway RSA key.

The plugin turns containers off. `test/run.test.ts` drives a run against a fake container, and the live results below are the proof against the real one. To check the probe script itself, build the image and run it with networking off: every denial should pass and every allowed call should fail.

```bash
docker build --platform linux/amd64 -t saw-agent orchestrator/container
docker run --rm --platform linux/amd64 --network none -e REPO=a/b -e ISSUE=1 -e SLUG=probe-test -e DEFAULT_BRANCH=main saw-agent /agent/probe.sh
```

### Live results

2026-11-04, deployed to the factory account, on the two testbeds. Status and reason come from the App's delivery log.

| Case | Status | Reason in the response |
| --- | --- | --- |
| Approver adds `agent:ready` to an open issue on an allowed repo | 202 | Released, and the App commented on the issue |
| The same delivery sent again | 200 | `duplicate delivery`, with no second comment |
| The agent App adds `agent:ready` | 200 | `sender isn't the approver` |
| Approver adds `agent:blocked` | 200 | `another label` |
| Approver adds `agent:ready` on a repo outside `ALLOWED_REPOS` | 200 | `repo isn't allowed` |
| Approver adds `agent:ready` to a closed issue | 200 | `issue isn't open` |
| Approver removes `agent:ready` | 200 | `action unlabeled` |
| The App's own comment comes back as an event | 200 | `event issue_comment`, so comments don't loop |
| Unsigned POST to `/webhook` | 401 | Sent directly, not by GitHub |

The Worker never exposes the token, so the live test didn't observe its scope or its revocation. Tests cover both. The comment was posted, and the Worker only reaches that step after checking the token lists exactly one repo.

### Live results: the outbound probe

2026-11-05, three runs on agent-testbed #34. Each run's full output is in its comment on that issue.

| Run | Build | Result |
| --- | --- | --- |
| 1 | `0.1.7+67a171a` | 40 of 42. Opening the draft PR waited 10.3 seconds and got a bare 502, so marking it ready failed too. GitHub accepted the same PR in 1.7 seconds when sent directly |
| 2 | `0.1.7+67a171a` | 42 of 42, on the same build |
| 3 | `0.1.8+42ec012` | 42 of 42, after intercepts were registered once per container |

What run 3 showed:

| Area | Checks | Result |
| --- | --- | --- |
| Network | A blocked host over HTTPS and HTTP, a bare IP over both, the metadata address, raw TCP to port 22, DNS for an unlisted name, plain HTTP to `github.com`, another GitHub host | All failed. Unlisted names timed out, and `github.com` resolved to a placeholder address |
| Git | Clone and two pushes to the run's branch | Worked |
| Git | Clone another repo, push to `main`, a second branch, another issue's branch, a tag, delete the branch | Refused by the policy with a 403 |
| Git | Force-push the run's branch | Refused by GitHub: "push declined due to repository rule violations". The testbed's ruleset log names `agent-branches`, "Cannot force-push to this branch" |
| GitHub API | Read the issue, open the draft PR, comment on the issue, mark the PR ready, a GraphQL read | Worked |
| GitHub API | Comment on another issue, a review, a merge, closing a blocker from the PR body, removing `agent:stop`, adding `agent:ready`, closing the issue, moving a ref, reading the installation or another repo, merging or removing a label by GraphQL, a GraphQL batch, a model call with no key | All refused with "Blocked by the outbound policy" and the reason |
| Credentials | The environment, every process's environment, files under `/etc`, `/root`, `/home`, `/tmp`, `/var`, `/opt`, `/usr/local`, and `.git/config` | No credential found |

The cause of run 1's 502 isn't confirmed. Run 2 passed on the same build, so the failure comes and goes. Re-registering intercepts on every check, while a request was in flight, is the likeliest cause, and no failure has occurred since that changed. The handler now logs any upstream 5xx, so a repeat would show where it came from.

Other findings:

- **Deploy token:** it needs Containers Edit. Without it, the first Containers API call failed with no reason, and the live Worker didn't change.
- **Plan:** the deploy and runs worked, so the factory account's plan supports containers.
- **Cost:** a run took about 4 to 5 minutes, judging from the push times and the network checks' timeouts. Container start-up wasn't measured. On a `lite` instance that's well under a cent, by my arithmetic from Cloudflare's pricing, and inside what Workers Paid includes.
- **Cleanup:** each run leaves a branch, a PR and a comment on the testbed. Runs 1 to 3 were cleaned up by hand.

### Live results: the first agent run

2026-11-06, build `0.1.10+0b1b612`, on agent-testbed #38: add a `## Status` section to the README.

| Step | Result |
| --- | --- |
| Release | The approver added `agent:ready`, and the App posted the run's status comment |
| Agent | Claude Code read the issue and the instructions, made one commit as the App's bot, and opened a draft PR with `agent-gh` |
| PR | Tier line, current step, `Closes #38`, a ticked checklist and run notes, as the instructions ask. Marked ready, with auto-merge on |
| Gate | Every check passed, including the tier check for a bot-authored tier 1 PR. The PR squash-merged on its own and closed the issue |
| Result | 7 turns, about $0.05, about 1.5 minutes from label to merge |

Two problems, fixed after the run:

- **`make` wasn't in the image,** so the agent couldn't run `make check`. It said so in its run notes and read the Makefile instead.
- **The result arrived as a second comment** instead of an edit to the status comment, so the run didn't have the start comment's id. The likeliest cause is the 3-second limit on GitHub calls, which dated from when the webhook made them. The limit is now 15 seconds. A run that's missing the id finds its start comment by the run id.

## Other options for a fork

From the [sandbox bake-off](../docs/research/sandbox-bakeoff.md):

| Option | Trade-off |
| --- | --- |
| E2B | Vendor-neutral, with Firecracker and egress control, and less to build. The fallback if this orchestrator stalls |
| Docker Sandboxes on your own host | The same security model and free, but needs that machine on |
| GitHub Actions runner with Harden-Runner | Free on public repos. Egress blocking is paid on private repos, and model keys sit on the runner |
| Claude Code cloud sessions | Every control built in, but tied to one vendor, and the session acts as a person's GitHub identity |

Replacing the sandbox host keeps the webhook intake and token minting in `src/`. Dropping this folder also means removing `package.json`, `pnpm-workspace.yaml` and `pnpm-lock.yaml` from the repo root.
