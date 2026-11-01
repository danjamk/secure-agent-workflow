# Credential naming

Every credential has one name, derived the same way everywhere: in the repo's manifest, in the broker, and in the provider's dashboard. Anyone, or any AI assistant, can go from a token in a dashboard to where it is stored and who reads it, with no lookup table.

This applies to this repo and to every project that uses it. The tools enforce or print it, so nobody has to remember it. ADR-007 explains the credential pattern itself.

## The names

| Thing | Pattern | Example |
| --- | --- | --- |
| Credential name: the manifest's `name` and the last part of the parameter path | `<system>-<role>-<kind>` | `cloudflare-deploy-token` |
| Token name in the provider's dashboard | `<repo>-<target>-<credential name>` | `agent-testbed-dev-cloudflare-deploy-token` |
| Parameter path in the broker account | `/<repo>/<target>/<exposure>/<credential name>` | `/agent-testbed/dev/preview/cloudflare-deploy-token` |
| A credential the platform itself uses, in the factory account | `saw-factory-<system>-<role>-<kind>` | `saw-factory-cloudflare-deploy-token`, `saw-factory-anthropic-api-key` |
| Environment variable, when a job needs one | The credential name, uppercase, with underscores | `CLOUDFLARE_DEPLOY_TOKEN` |

The parts:

- **repo** is the full repository name, not an alias.
- **target** is `dev` or `prod` (see Account terms in the README).
- **exposure** is `preview` or `staging` in the dev target, and `prod` in the prod target. It is a storage decision, so it stays out of the dashboard name: moving a credential from `preview` to `staging` doesn't rename the token.
- **system** is the provider, and matches the manifest's `system` field: `cloudflare`, `stripe`, `resend`, `auth0`.
- **role** says what the credential does: `deploy`, `read`, `infra`, `api`, `webhook`, `signing`.
- **kind** is `token`, `key` or `secret`, so the name says what you're holding.

## Rules

1. **One credential per repo, target and purpose.** Never share a token between repos or between targets. A shared token breaks the mapping, and revoking it for one repo breaks the other.
2. **Grant only what the manifest's `permissions` lists, in one account.** The checker can confirm a credential works and which account it reaches, not that it lacks extra permissions.
3. **Values never pass through an AI assistant or a file.** Create the token in the dashboard and paste it straight into `broker.sh setup` or `broker.sh set`.
4. **An agent asks for a credential by adding a manifest entry.** It names the entry by this convention, says why in `purpose`, and lists the permissions. The approver merges it, and the operator creates and stores the value.

## What the tools do

- The manifest validator rejects a `name` that doesn't start with `<system>-` and end in `-token`, `-key` or `-secret`.
- `broker.sh setup <owner>/<repo>` walks through every credential that is missing or failing. It prints the dashboard name, the target, and the permissions for each one, then prompts for the value.
- `broker.sh set` prints the dashboard name before it prompts. `broker.sh status` shows it on every credential line, so a failing line names the token to fix.

## For AI assistants

When a conversation involves creating, storing, naming or finding a credential, in this repo or in a project that uses it:

- Use these names, and give the user the dashboard name to type.
- Point the user to `broker.sh setup` or `broker.sh set` to store a value. Never ask the user to paste a value into the conversation.
- To find where a dashboard token is stored, strip `<repo>-<target>-` from its name, then read the manifest entry with that name for the exposure.
