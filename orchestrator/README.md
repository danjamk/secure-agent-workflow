# Orchestrator

A Cloudflare Worker in the factory account that starts a sandbox per released issue (ADR-004). It's built in steps, and this is what exists today:

| Built | Not built yet |
| --- | --- |
| `/health`, webhook intake, the release checks, delivery dedupe, installation tokens | Outbound handlers (#8), the sandbox and agent CLI (#9), logs (#10), stop and resume (#11), the coordinator (#13) |

An accepted release mints a token, posts a comment saying no run started, and revokes the token. The comment proves the path from label to GitHub write. #9 replaces it with starting a run.

## What counts as a release

The Worker acts on a webhook only if all of these hold. Anything else gets a 200 with the reason in the body, which shows in the App's delivery log.

- The `X-Hub-Signature-256` signature matches the raw body.
- The event is `issues.labeled` with the label `agent:ready`.
- The sender is `APPROVER_LOGIN` and is a user account. The agent App has `issues: write`, so it can add this label too; that's ignored (ADR-005).
- The repo is in `ALLOWED_REPOS`.
- The issue is open.
- This delivery id hasn't been accepted before.

An empty `APPROVER_LOGIN` or `ALLOWED_REPOS` means nothing is released, and a missing webhook secret means every webhook gets a 500.

If minting or commenting fails, the Worker returns a 502 and forgets the delivery id, so redelivering it from the App's delivery log tries again.

## Contract with the sandbox

Written ahead of #8 and #9, which have to keep to it.

| | |
| --- | --- |
| Goes in | The issue body, `standards/agent-instructions.md`, and a clone over HTTPS |
| Comes out | Commits on `agent/<issue>-<slug>`, a PR, issue and PR comments, the `agent:blocked` label, and the run's log |
| Never enters | The App private key, the webhook secret, installation tokens and model API keys. The outbound handler adds tokens and keys to each request |
| Network | Deny by default, with an allowlist. Only HTTP and HTTPS reach the handlers |

## Contracts with other components

| Component | What the orchestrator expects |
| --- | --- |
| `bootstrap/github-app/` | An App with the permissions in its README, and its id, private key and webhook secret in the Keychain until `connect-app.sh` copies them |
| `bootstrap/` | The `agent:*` labels on each repo |
| `standards/agent-instructions.md` | The branch pattern, labels and PR format |
| `gate/` | Nothing directly. The gate judges the PR the agent opens |

## Credentials

| Item | Where it lives | Set by |
| --- | --- | --- |
| `GITHUB_APP_PRIVATE_KEY` | Worker secret, PKCS#8 | `connect-app.sh` |
| `GITHUB_WEBHOOK_SECRET` | Worker secret | `connect-app.sh` |
| `CLOUDFLARE_API_TOKEN` | `.env.local`, until CI deploys this | The operator. This account is never a deploy target for an app, and `broker.sh set` refuses this token |

## Deploying

Run from a clean checkout. `.env.local` at the repo root needs `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`, `APPROVER_LOGIN`, `ALLOWED_REPOS` and, after the first deploy, `ORCHESTRATOR_URL`.

```bash
make -C orchestrator deploy    # the first run prints the Worker's URL
make -C orchestrator connect   # copies secrets, points the App's webhook at the Worker
make -C orchestrator health    # checks the live Worker matches this checkout
```

The account, the Worker's URL and the repo list stay out of committed files.

## Tests

```bash
make -C orchestrator check           # typecheck and every test
make -C orchestrator test-security   # who can release an issue
```

Tests run in the Workers runtime through `@cloudflare/vitest-plugin`, with a real Durable Object. Only GitHub is stubbed. Each run generates its own throwaway RSA key.

## Other options for a fork

From the [sandbox bake-off](../docs/research/sandbox-bakeoff.md):

| Option | Trade-off |
| --- | --- |
| E2B | Vendor-neutral, with Firecracker and egress control, and less to build. The fallback if this orchestrator stalls |
| Docker Sandboxes on your own host | The same security model and free, but needs that machine on |
| GitHub Actions runner with Harden-Runner | Free on public repos. Egress blocking is paid on private repos, and model keys sit on the runner |
| Claude Code cloud sessions | Every control built in, but tied to one vendor, and the session acts as a person's GitHub identity |

Replacing the sandbox host keeps the webhook intake and token minting in `src/`. Dropping this folder also means removing `package.json`, `pnpm-workspace.yaml` and `pnpm-lock.yaml` from the repo root.
