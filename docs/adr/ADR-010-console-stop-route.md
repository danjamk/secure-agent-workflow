# ADR-010: The console stops a run through an orchestrator route behind Cloudflare Access

Status: Proposed · Date: 2026-11-06 · Revised: 2026-11-06 (topology on `workers.dev`, with no custom domain, #101)

## Context

Phase 1 of the operator console has one action, Stop: press-and-hold on a running row, on desktop and phone (spec 0002, Phasing and hard constraint 4). Three existing rules decide how it can work:

- #11 stops a run when `agent:stop` is added, or `agent:ready` removed, **by the repo owner**. The agent's App has `issues: write`, so a label added by the App is ignored, the same way intake ignores an App-added `agent:ready` (ADR-005).
- The console holds no credential the orchestrator doesn't already hold (spec 0001, Later: operator console; spec 0002, hard constraint 9).
- The operator's identity in the console is the Cloudflare Access identity (spec 0002, hard constraint 6).

So the console can't add `agent:stop` as the owner without holding a credential that acts as the owner. Spec 0002 leaves this open (Open decisions, Stop).

Stop is also on the critical path that must survive a lost feed (hard constraint 7). Whatever the console calls must work when the read routes don't.

## Decision

The console calls a stop route on the orchestrator. The orchestrator authenticates the operator by verifying the Cloudflare Access JWT itself, then runs #11's stop.

**Topology.** The factory account has no custom domain, and the operator would rather not add one (#101). So the console is a Worker on its own `workers.dev` hostname, serving static assets, with Cloudflare Access protecting the whole Worker (Workers & Pages → the Worker → Access). That's free, and it needs no domain. The Access application allows only the operator.

The console Worker sends `/api/*` to the orchestrator over a service binding, forwarding the browser's request as it is, with the `Cf-Access-Jwt-Assertion` header Access added. The browser calls the console same-origin. **The binding only carries the request.** The orchestrator trusts nothing about it, and verifies the JWT itself, as below. The console Worker holds no secrets, and has no way to act except by forwarding an operator's request. The orchestrator's own `workers.dev` hostname has no Access, so `/webhook` stays reachable by GitHub, and `/api/*` there gets 403 for want of a valid JWT.

A binding is used rather than `fetch` to the orchestrator's public URL, because it's Cloudflare's documented way for one Worker to call another without going through a public URL. Cloudflare's docs also say a Worker called through a binding shouldn't treat the request as authenticated by the caller's Access context, which is why the JWT is checked again here. That the binding keeps `Cf-Access-Jwt-Assertion` as sent isn't documented. #105 tests it.

**The route.** `POST /api/runs/<repo>/<issue>/stop`. This refines the path proposed in spec 0002 by putting it under `/api/`.

**The orchestrator checks, in order, and fails closed:**

| Check | Rule |
| --- | --- |
| Access JWT | `Cf-Access-Jwt-Assertion` is present, its signature verifies against the team's published keys, `aud` is the console application's tag, and it hasn't expired. Verified in the orchestrator on every `/api/*` request, so `/api/*` on the orchestrator's own hostname, which Access doesn't cover, gets 403 |
| Identity | The JWT's `email` equals `OPERATOR_EMAIL`, a Worker variable set by hand alongside `APPROVER_LOGIN`. Stops are recorded as `APPROVER_LOGIN` |
| Cross-site requests | The request has `Content-Type: application/json` and an `Origin` equal to the console's `workers.dev` hostname. A form post from another site fails both |
| Target | `<repo>` is in `ALLOWED_REPOS` and the issue has a live run. Otherwise 404, and nothing changes |

**Then it runs the same stop as `agent:stop`** (#11): set the run's stop flag, revoke the installation token, tear down the sandbox. After that, with the App's installation token, it adds `agent:stop` to the issue so the label history shows the stop, and comments on the PR: "Stopped by `<APPROVER_LOGIN>` from the operator console." #11 already ignores labels the App adds, so this label triggers nothing.

**It returns 202** with the run's state. The console shows the stop sequence from the run's stop steps (requested, token revoked, sandbox torn down), each with a time, which the runs read route returns.

**Stop is the only write the route surface has in Phase 1.** It can't dispatch, resume, approve, merge or remove a label. A later action through the same path needs its own ADR.

## Alternatives considered

- **A GitHub user token in the console (spec 0002's alternative).** The console signs the operator in with GitHub and adds `agent:stop` as the owner, so #11 works unchanged. It lost because the console would hold a user token with `issues: write`, which can also add `agent:ready` and so dispatch work, and spec 0001 rules out any new credential in the console.
- **The orchestrator adds `agent:stop` with the App token, and #11 accepts App-added labels.** No new route logic beyond a label call. It lost because the agent's App can add labels too, so #11 would have to trust a label the agent could have set. That breaks the rule intake and #11 share: only the owner's login acts.
- **Stop links out to GitHub.** The Stop control opens the issue, and the operator adds `agent:stop` there. Nothing new to build or secure. It lost because it breaks hard constraint 4 (press-and-hold in the console), takes several taps on a phone, and the approved design has Stop in the console.
- **A service binding that the orchestrator trusts.** The console Worker verifies the JWT and calls the orchestrator over a binding, which trusts it. The binding the revised topology uses is different: it only carries the request, and the orchestrator still verifies the JWT. This option lost because the orchestrator would then trust whatever the console sends, so a bug in console code, which agents write, could stop any run. With the orchestrator verifying the JWT itself, the console holds no authority at all.
- **A custom domain, with a Workers route sending `/api/*` on it to the orchestrator.** This was the topology before the revision. It works the same way, but the operator would rather not buy and manage a domain for one console.
- **Access on the orchestrator's own hostname, with a bypass for `/webhook`.** No second Worker. It lost because Cloudflare's docs don't show a path bypass under a `workers.dev` hostname, and a mistake there would either expose `/api/*` or cut off GitHub's webhooks.
- **GitHub sign-in for identity only (`read:user`).** The orchestrator stops the run after GitHub proves the owner's login. It lost because it needs an OAuth app and its client secret, a new credential, to replace an identity Access already provides.

## Consequences

- The console holds no credential. Its code can't stop anything on its own; the orchestrator decides every stop from the operator's Access identity.
- The audit trail stays in GitHub: the `agent:stop` label event and the PR comment. The label comes from the App, not the owner's login, so the comment is what names the operator.
- The owner's Access identity becomes a second way to act as the owner, for Stop only. Anyone who can sign in to Access as `OPERATOR_EMAIL` can stop runs. The worst case is stopped runs, which is the safe direction.
- The orchestrator gains Access JWT verification and `ACCESS_TEAM`, `ACCESS_AUD` and `OPERATOR_EMAIL` (#101), and the console Worker gains a service binding to it (#105). The orchestrator is tier 3 here, so this is human-authored.
- #11 needs no change. It already ignores labels the App adds, including the `agent:stop` the orchestrator adds after an Access stop.
- Stop depends only on the orchestrator being up, not on the read routes, so it keeps working when the feed is lost.
