# Console

The operator console (spec 0002): a Cloudflare Worker in the factory account, `saw-console`, on its own `workers.dev` hostname. Cloudflare Access protects the whole Worker. It will show what's waiting on the operator, what's running and spend, and let the operator stop a run. `design/` holds the approved design, and `docs/plans/console-phase-1.md` the build plan.

| Built | Not built yet |
| --- | --- |
| The Worker, `/health`, `/api/*` forwarded to the orchestrator, a placeholder page, the deploy (#105) | The Phase 1 screens (the console wave in the plan) |

Today the console's one use is reading a run's log at `/api/runs/<run>/log`. Each run's status comment links to it.

## How it works

ADR-010 has the reasons, revised for a factory account with no custom domain.

- **Access covers the whole Worker,** including `/health`. Nothing on the console's hostname answers without the operator signing in.
- **`/api/*` goes to the orchestrator** over the `ORCHESTRATOR` service binding. The console forwards the request as the browser sent it, with Access's `Cf-Access-Jwt-Assertion` header, and drops cookies. If the header is missing, it copies the same token from Access's `CF_Authorization` cookie into it.
- **The console has no authority.** The orchestrator verifies the token itself on every `/api/*` request: the signature, the application, expiry, and the operator's email (`orchestrator/README.md`, Operator routes). A bug in console code can forward a request, but it can't make one the operator didn't.
- **Everything else is static files** from `public/`, served without running the Worker, under the Content-Security-Policy in `public/_headers`.

## Setting it up

Do these in the factory account, once. Cloudflare has renamed some of these menus, so if a label differs, use whichever one your dashboard shows.

1. **Turn on Zero Trust.**
   - **Zero Trust** → choose a team name: lowercase letters, digits and hyphens. It becomes `<team>.cloudflareaccess.com`.
   - Choose the **Zero Trust Free plan**. It asks for payment details. Cloudflare's docs say you won't be charged.
   - The default sign-in method is your Cloudflare login. Optional: **Integrations** → **Identity providers** → **One-time PIN**.
2. **Deploy the console.** `console-deploy.yml` runs when a change to `console/` merges. You can also run it from the Actions tab.
3. **Protect it.**
   - **Workers & Pages** → `saw-console` → **Access** → **Protect this Worker behind Access** → **All traffic** → policy **Cloudflare account** → **Apply Access**.
   - Then, in **Zero Trust** → **Access** → **Applications**, edit that application's policy so its only **Include** rule is **Emails** = your email.
4. **Give the orchestrator its settings.** Put these in `.env.local`, then store each one with `broker.sh set-factory`:

   | `.env.local` | Broker setting | Where to find it |
   | --- | --- | --- |
   | `ACCESS_TEAM` | `access-team` | Zero Trust → Settings |
   | `ACCESS_AUD` | `access-aud` | The application → Edit → Additional settings → Application Audience (AUD) Tag |
   | `OPERATOR_EMAIL` | `operator-email` | The email Access signs you in with |
   | `CONSOLE_URL` | `console-url` | The console's `workers.dev` URL, `https://` included, no trailing slash |

   ```bash
   AWS_PROFILE=saw bash deploy/broker/aws/broker.sh set-factory <owner>/<repo> access-team
   ```

   Then run `orchestrator-deploy` from the Actions tab. All four settings are optional in the deploy, so the orchestrator deploys without them. Until they're set, it refuses every `/api` request and posts no log link.
5. **Check it.**
   - Open `<console URL>/api/runs/<run>/log` for a recent run. You should see its log after signing in.
   - A browser that isn't signed in should get Access's sign-in page.
   - The orchestrator's own URL should return 403 for the same path.

**Log links and public repos.** On a private repo, a run's status comment and PR link the log in full. On a public repo they give only the path, because the console's hostname would also give away the orchestrator's, and neither goes into public comments.

## Contracts with other components

| Component | What the console expects |
| --- | --- |
| `orchestrator/` | The `/api/*` routes, reached through the `ORCHESTRATOR` service binding, which check the Access token themselves. Today that's the log route. The Phase 1 screens add the waiting, runs, factory and stop routes (spec 0002). The console never talks to a sandbox |
| GitHub | Read-only, through the orchestrator: blocked issues and their handoff notes, PRs waiting on approval, check runs. Every action other than Stop is a link out to GitHub |
| Cloudflare Access | Protects the whole Worker, and signs the token the orchestrator checks. The console shows the identity and forwards the token |

The console holds no credential, and nothing the orchestrator doesn't already hold (spec 0001).

## Other options for a fork

| Option | Trade-off |
| --- | --- |
| No console: GitHub notifications and the Slack digest only | Nothing to build or host, but no one place shows spend or what's running |
| A GitHub Projects board fed by labels | Familiar and free, but no live run state, cost or Stop |
| A custom domain, with a Workers route sending `/api/*` to the orchestrator | ADR-010's first topology. No service binding, but a domain to buy and manage |
