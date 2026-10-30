# ADR-002: Production credentials come through a GitHub OIDC broker on AWS

Status: Accepted · Date: 2026-10-30

## Context

Deploys target Cloudflare, AWS and third-party services. Cloudflare's documented GitHub Actions path is a stored API token; it has no OIDC federation. Long-lived production secrets in GitHub are what a compromised workflow or action steals first.

## Decision

GitHub OIDC is the single trust anchor. An AWS IAM role trusts only the subject `repo:danjamk/<repo>:environment:production` and reads production secrets from SSM Parameter Store standard parameters, including the Cloudflare token. The broker sits behind one small interface in `deploy/`.

## Alternatives considered

- **Cloudflare token in a GitHub environment secret.** Simplest, but the token is long-lived and stored in GitHub. Acceptable as a starting point; the broker replaces it.
- **HashiCorp Vault.** Preferred brand. No free hosted tier: HCP Vault Secrets ended July 1, 2026, and HCP Vault Dedicated starts around $450 a month. Self-hosted Community Edition means running and unsealing a server.
- **OpenBao.** The MPL-licensed Vault fork. Same self-hosting cost as Vault.

## Consequences

- No static production secrets in GitHub.
- The cloud provider, not just GitHub, refuses credentials to any branch or job outside `environment:production`.
- A client with Vault or OpenBao swaps the broker without touching workflows.
