# ADR-002: Deploy credentials come through a GitHub OIDC broker on AWS

Status: Accepted · Date: 2026-10-30 · Revised: 2026-10-31 (dev and prod stores; OIDC subjects with immutable IDs; dev role split into preview and staging, OpenTofu state bucket, per ADR-006) · Revised: 2026-11-01 (roles read by exposure path, per ADR-007)

## Context

Deploys target Cloudflare, AWS and third-party services. Cloudflare's documented GitHub Actions path is a stored API token; it has no OIDC federation. Long-lived secrets in GitHub are what a compromised workflow or action steals first.

Deploys go to two places: previews and staging in the dev target, and production in a separate prod target (spec 0001, Branches and environments). Developers need to manage dev keys without any path to production keys.

## Decision

GitHub OIDC is the single trust anchor. The broker has three AWS IAM roles per consumer repo. Secrets are SSM Parameter Store standard parameters at `/<repo>/<account>/<exposure>/<name>`, and each role reads by path prefix (ADR-007):

| Role | Trusts only | Reads |
| --- | --- | --- |
| Preview | `repo:danjamk@<owner-id>/<repo>@<repo-id>:environment:preview` | `/<repo>/dev/preview/*`: the Cloudflare deploy token (Workers only), read-only token and account ID. Dev OpenTofu state, read-only |
| Staging | `repo:danjamk@<owner-id>/<repo>@<repo-id>:environment:staging` | `/<repo>/dev/preview/*` and `/<repo>/dev/staging/*`, which holds the Cloudflare infrastructure token. Dev OpenTofu state, read-write |
| Prod | `repo:danjamk@<owner-id>/<repo>@<repo-id>:environment:production` | All of `/<repo>/prod/*`. Prod OpenTofu state, read-write |

Preview and staging both deploy to the dev target, but only staging can change its infrastructure. Preview jobs run the PR's build scripts, so they never get the infrastructure token (ADR-006).

The broker's template also creates the S3 bucket that holds OpenTofu state (ADR-006).

The subjects include GitHub's numeric owner and repo IDs. Repos created after July 15, 2026 get this format by default; older repos opt in through the repo's OIDC settings. Matching on IDs means a repo deleted and recreated under the same name can't assume the role. Seen on a testbed token (bootstrap README, #30).

The roles may live in two AWS accounts or one. Two accounts are stronger: a developer with dev-account access has no access to prod at all. One account is allowed for low-stakes projects, and v1 uses one; the prod role's trust policy still refuses every subject except `environment:production`. The broker sits behind one small interface in `deploy/`.

The preview and staging roles are built first. The prod role is built with the production release path (spec 0001, build order step 3).

## Alternatives considered

- **Cloudflare tokens in GitHub environment secrets.** Simplest, but the tokens are long-lived and stored in GitHub. Reasonable for the dev store on a small project; not for prod.
- **HashiCorp Vault.** Preferred brand. No free hosted tier: HCP Vault Secrets ended July 1, 2026, and HCP Vault Dedicated starts around $450 a month. Self-hosted Community Edition means running and unsealing a server.
- **OpenBao.** The MPL-licensed Vault fork. Same self-hosting cost as Vault.
- **One role for all environments.** Fewer moving parts, but any deploy job could read production secrets.

## Consequences

- No static deploy secrets in GitHub.
- The cloud provider, not just GitHub, refuses prod credentials to any job outside `environment:production`, and dev credentials to any job outside `preview` and `staging`. Only `staging` gets the dev infrastructure token.
- A fork or client with Vault, OpenBao or another cloud's store swaps the broker without touching workflows, and can put each store wherever its own key management requires.
