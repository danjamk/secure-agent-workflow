# ADR-007: Every credential is declared in the repo, checked before it is stored, and reported on

Status: Proposed · Date: 2026-11-01 · Revised: 2026-11-01 (manifest field `account` renamed `target`, with the account terms in the README)

## Context

The broker (ADR-002) holds the credentials the pipeline uses. Today those are three Cloudflare tokens and an account ID per account. A real app adds tokens from other systems: a payment provider's test and live keys, an email API key, a model API key, an analytics write key. Each new system brings the same questions:

- Who needs it?
- Which job may read it?
- Is the stored value the right one?
- When does it expire?

The operator puts every value in by hand, and nothing checks it until a deploy fails. Nothing lists which credentials a repo needs, which are missing, or which are about to expire.

The broker's roles name each Cloudflare parameter in their IAM policies. Adding a credential for a new system means editing CloudFormation.

Preview jobs run a PR's build scripts (ADR-006). Any credential the preview role can read is readable by agent-written code.

## Decision

Credentials from any system follow one pattern: declare it, check it before storing, and report on it.

**Declared.** Each consumer repo lists the credentials it needs in `infra/credentials.yml`. `infra/**` is tier 2, so the agent can ask for a new credential by adding an entry, and the approver sees the request. The agent never sees a value.

```yaml
credentials:
  - name: cloudflare-deploy-token
    system: cloudflare         # selects the checker
    target: dev                # dev or prod target
    exposure: preview          # preview, staging or prod: the first job that may read it
    purpose: Deploy preview and staging Workers
    permissions: "Workers Scripts: Edit. Account Settings: Read"
    check: workers             # arguments for the checker: what this credential must be able to do
    rotate_days: 90
```

The manifest uses only this flat shape, so the broker reads it with a few lines of standard-library Python, as the gate does for `tier-map.yml`.

**Exposure is set by the parameter's path.** Parameters live at `/<repo>/<target>/<exposure>/<name>`. Each role reads by path prefix, so a new credential needs no IAM change:

| Role | Reads |
| --- | --- |
| Preview | `/<repo>/dev/preview/*` |
| Staging | `/<repo>/dev/preview/*` and `/<repo>/dev/staging/*` |
| Prod | `/<repo>/prod/*` |

A credential under `preview/` is readable by code the agent wrote. Only test-mode or read-only credentials go there.

**Checked before it is stored.** The operator runs `broker.sh set <owner>/<repo> <name>`:

1. It reads the entry from the manifest on the default branch.
2. It prompts for the value without echoing it.
3. It runs the system's checker.
4. It stores the value only if every check passes.

Tags on the parameter record:
- when it was set;
- the AWS identity that set it;
- when it was last checked;
- the expiry date, when the system reports one.

A system with no checker can still be stored, and it is reported as unchecked.

**Checkers.** Each system has one executable at `deploy/credentials/checks/<system>`, in any language, with a fixed contract:

- It receives the manifest's `check` words as arguments.
- It reads the secret on stdin, never from an argument or the environment.
- It writes lines of the form `PASS <text>`, `FAIL <text>` or `INFO <text>`.
- It may also write `EXPIRES <date>` and `IDENTITY <id> <label>`.
- It exits non-zero if any line is `FAIL`.
- It never prints the secret.

`IDENTITY` is the account the credential belongs to. The first credential stored for a system and target records the identity, and the operator confirms it by name. A later credential for the same system and target must report the same identity. This catches a dev-account token copied into the prod path, or a token from the wrong account entirely. Adding a system means adding one checker file and its manifest entries.

**Reported on.** `broker.sh status <owner>/<repo>` prints one line per credential, with a pass or fail:

- declared but missing;
- stored but not declared;
- still a placeholder;
- the check fails now;
- expiring within 14 days;
- older than `rotate_days`;
- unchecked.

It also checks the stacks, the role trust subjects and the environment secrets. A scheduled workflow runs the same checks daily in the `staging` environment. It opens or updates one issue when anything fails, so a revoked or expiring token shows up before a deploy needs it.

**Runtime secrets** that the app itself reads, such as a payment provider's API key, use the same manifest and paths. The deploy job copies them into the Worker as secrets (#18, deploy template).

## Alternatives considered

- **A broker subcommand per system** (`set-cloudflare-tokens`). Simplest for the first system. Every later system edits `broker.sh` and the IAM policies, and no single place lists what a repo needs.
- **AWS Secrets Manager.** It has built-in rotation, but rotation needs a Lambda per system, and most SaaS tokens can't be rotated by API. It costs $0.40 per secret per month, while Parameter Store standard parameters are free. A fork that wants rotation can swap the store and keep the manifest and checkers.
- **A vault product as the source of truth** (1Password, Doppler, Infisical). It gives better operator UX and sharing, but adds a service and its own credential to the trust chain. It remains a fork option: the checker contract doesn't depend on where the value is stored.
- **GitHub environment secrets.** They have no read audit, the values are long-lived, and a compromised workflow can read them (ADR-002).
- **Naming exposure in the manifest only, with IAM listing each parameter.** Exact per-parameter grants, but every new credential needs a CloudFormation change.

## Consequences

- Adding a system takes a manifest entry, one checker file if the system has a way to verify a key, and one `broker.sh set` per credential. No IAM change.
- The operator sees every credential's state in one report. Expiry and revocation show up as an issue before a deploy fails.
- The agent can ask for a credential through a tier 2 PR and never handles the value.
- The parameter paths change from `/<repo>/dev/<name>`. The #17 roles and testbed tests move to the new layout. Only placeholders are stored today.
- Checkers can show that a credential works and which account it belongs to. Most can't show that it has no more permission than it should, because reading a token's permissions usually needs a broader token. The manifest's `permissions` field is the operator's checklist for that.
- The scheduled check reads `staging` and `preview` credentials only. Prod credentials are checked by `status` on the operator's laptop until the prod role exists (#32).
