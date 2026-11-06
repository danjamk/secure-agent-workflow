# ADR-011: Runs can execute on a Cloudflare host or a local host

Status: Proposed · Date: 2026-11-06 · Amends: [ADR-004](ADR-004-cloudflare-sandbox.md)

## Context

ADR-004 runs every build agent in a Cloudflare container. That holds up: the orchestrator runs Claude Code on released issues, with the outbound policy and spend budgets enforced (#88, #96).

Three things argue for a second place to run:

- **Token cost.** On Cloudflare, every model call bills a model API key. Dan's interactive work already runs on a flat subscription. The early estimate for unattended work is about $3–4 per merged PR on a `standard` model, so a busy month could cost more than the subscription itself.
- **A dedicated machine.** Dan's remote dev machine (Ryzen AI 9 HX 370, Ubuntu) arrives around 2026-11-13. It can run sandboxes at no compute cost, and its local model is reachable without leaving the house.
- **Portability.** Spec 0001 goal 6 says the model should map onto enterprise infrastructure without a redesign. A second host proves the controls don't depend on Cloudflare.

The repo already uses "runner" for the agent CLI module (`src/agents/`). This ADR uses **host** for where the run executes.

## Decision

**A run executes on a host.** There are two: `cloudflare`, which is ADR-004 unchanged, and `local`. A repo picks one in a broker setting the agent can't edit, and `cloudflare` stays the default.

**The policy is shared, and the plumbing is per host.** The decision modules in `orchestrator/src/outbound/` (`git`, `rest`, `graphql`, `models`, `scope`, `spend`) are pure functions with no platform imports. Both hosts call them. Everything else is per host:

| Concern | `cloudflare` | `local` |
| --- | --- | --- |
| Trigger | `issues.labeled` webhook | Daemon polls GitHub for `agent:ready`, so no inbound port is opened |
| Run state | `RunState` Durable Object, alarm every 10 s | Daemon process, run records in SQLite |
| Sandbox | Container with `enableInternet: false` | Rootless Podman container on the gVisor runtime (`runsc`), one per run |
| Egress | Platform intercepts listed hosts and sends them to the `Outbound` entrypoint | The container's network can reach only the policy proxy. An nftables rule drops everything else, DNS included |
| TLS | Platform CA | A CA owned by the proxy user, mounted read-only into the container |
| Credentials | Worker secrets | Files readable only by the proxy's Linux user. The GitHub App key mints tokens there and never enters the sandbox |
| Model auth | API key | API key by default, or a subscription OAuth token (below) |

**The local host runs as its own Linux user.** The daemon and proxy run as `factory`. That user has no access to Dan's home directory, his interactive Claude Code sessions, his notes or his SSH keys, and Dan's own account can't read `factory`'s secrets without sudo.

**Subscription auth is an operator choice on the local host only.** The proxy can inject a Claude subscription OAuth token where it would otherwise inject an API key. The sandbox can't tell the difference. The default stays API keys, because Anthropic limits subscription OAuth to ordinary individual use of its own apps, and how far that reaches into unattended runs has changed during 2026. The spend meter still prices every call at API list price on either credential, so cost per PR stays comparable across hosts.

**Build order.** Work on the reference build starts now on `cloudflare` (with API keys and the existing $5 per-run cap). `local` is built on the remote machine after it arrives, and it ships only after the red-team scenarios in spec 0001 pass on it.

## Alternatives considered

- **Docker Sandboxes (`sbx`) as the local sandbox.** It's a strong tool: microVMs, deny-by-default egress and a proxy that injects credentials. Its own proxy terminates TLS and injects credentials, so applying this repo's policy (the GitHub call allowlist, GraphQL parsing, push filter and spend meter) would mean a second TLS interception or forking that proxy. Revisit if `sbx` adds a policy hook, or if gVisor proves too weak and a microVM is worth the extra layer.
- **Firecracker microVMs.** Stronger isolation than gVisor, but more to operate on one machine. It's the next step up if the red-team or a design review asks for it.
- **Running agents directly on Dan's Mac.** The Mac holds `.env` files and his identity, which is the blast radius this project exists to shrink.
- **Claude Code cloud sessions.** They run on the subscription with no extra token cost, but they act as Dan's GitHub identity and are tied to one vendor (ADR-004).
- **Moving entirely to `local`.** It's cheaper, but runs would stop when the machine is off, and the design would lose the proof that the controls work on a cloud platform.

## Consequences

- The outbound modules must stay free of `cloudflare:workers` imports. A lint rule or test enforces it.
- `handler.ts` splits into a shared request pipeline and a thin Worker entrypoint. The local proxy is the second entrypoint.
- `models.ts` needs a second credential shape for the subscription token, `authorization: Bearer` plus the OAuth beta header, chosen by the host's setting. That has to be verified against the Claude Code version the image pins.
- The red-team suite gains local-host cases: reaching the host's LAN, reaching the host's own services, reading the proxy's CA key, and escaping gVisor through mounted paths.
- Runs on `local` only happen while the machine is up. Released issues wait until it comes back, and the console shows the host as offline.
- The run metrics record the host and credential type, so the retro can compare cost per merged PR across hosts.
