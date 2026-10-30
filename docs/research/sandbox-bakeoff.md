# Sandbox bake-off for the build agent

Researched 2026-10-29. Prices and features are from vendor docs on that date. Costs assume about 20 agent-hours a month on 2 vCPU / 4 GiB, compute only. Model tokens are extra unless a subscription covers them.

## Recommendation

Run the build agent in the **Cloudflare Sandbox SDK**, with a GitHub App as its identity. Use Claude Code cloud only for the human-in-the-loop planning agent. This revision follows the requirement that the build platform be neutral on agent and model vendor.

- **Why the Cloudflare Sandbox SDK.**
  - **Vendor-neutral.** It runs any agent CLI against any model vendor.
  - **Credentials stay outside.** Deny-by-default egress (`enableInternet = false` plus `allowedHosts`), and Worker outbound handlers inject credentials so "no token is exposed to the sandbox" [14].
  - **Low cost on the default cloud.** It runs on Cloudflare for about $5–7 a month [13].
  - **Branch-scoped pushes are possible.** The handlers see each request, so the push filter can reject ref updates outside `agent/*`. That part is custom code, and Cloudflare's docs don't cover it.
- **Why a GitHub App identity.** The outbound handler mints a short-lived installation token, and the App's private key never enters the sandbox. PRs are authored by the App's bot, so the repo owner can approve them, and no second GitHub account is needed.
- **Fallback: E2B.** It is also vendor-neutral: Firecracker, deny-all egress with an allowlist, and beta proxy header injection. There's less to build, but it isn't on Cloudflare [12].
- **Planning agent: Claude Code cloud or Claude's normal UI.** Lock-in is acceptable with a human in the loop. Cloud sessions act as the connected GitHub user, with commits, PRs and `gh api` calls made as that user [2][3]. Keep planning sessions to specs and issues, not merges.
- **Local interactive work: Docker Sandboxes.** It's free and vendor-neutral, with microVMs, deny-by-default egress and proxy-injected credentials. It doesn't run unattended in the cloud [9][10].

## Comparison

| Option | Isolation | Deny-by-default egress | Secrets stay outside | Unattended trigger | ~20 h/mo | Setup |
| --- | --- | --- | --- | --- | --- | --- |
| **Claude Code cloud** | Managed VM per session | Yes: None, Trusted, Custom, Full [2] | Yes: GitHub proxy plus network secrets [2] | Schedule, API `/fire`, GitHub PR/issue/release events [3] | $0 beyond subscription [1] | Low |
| claude-code-action on hosted runners | Actions VM | Only with Harden-Runner [6] | No: tokens are on the runner [7] | `@claude`, issue assignment, cron [7] | $0 on public repos | Low–Med |
| Copilot cloud agent | Ephemeral Actions env, 59-min cap [8] | Firewall covers the agent's shell only, not setup or MCP [8] | Not documented | Assign an issue | Copilot Pro $10/mo | Low |
| Codespaces | VM | **No**: full outbound internet [15] | No: secrets become env vars [15] | Not designed for it | Pro quota | Low |
| Docker Sandboxes | microVM | Yes: all outbound blocked unless allowed [10] | Yes: host proxy injects auth [10] | Local only | Free | Low |
| Local devcontainer (Trail of Bits) | Docker container | Opt-in iptables; changeable from inside [11] | No [11] | Headless token auth | Free | Med |
| E2B | Firecracker | Yes: deny all, allow domains or CIDRs [12] | Beta: proxy header injection [12] | You build it | ~$3, $100 one-time credit | Med–High |
| Daytona | Own kernel | Fixed on lower tiers; CIDR list only on Tier 3+ [16] | Not verified | You build it | ~$3, $200 credit | Med–High |
| Modal Sandboxes | gVisor or VM | Yes: block network, CIDR allowlist, domain allowlist in beta [17] | Env-var secrets only | You build it | ~$5, $30/mo credit | Med–High |
| Cloudflare Sandbox SDK | microVM | Yes: `enableInternet=false` plus `allowedHosts` [14] | Yes: Worker outbound handler injects tokens [14] | Any Worker trigger | ~$5 plan + $1–2 | High |

## Known gaps: Cloudflare Sandbox SDK (build agent)

- **Only HTTP and HTTPS on ports 80 and 443 pass through handlers.** Git must use HTTPS, not SSH [14].
- **The orchestrator Worker, token minting and push filter are code we write and maintain.** That's the setup cost behind the "High" rating.
- **Model traffic is allowlisted per vendor.** Each model API host is an allowed exfiltration path, the same tradeoff as every option here.

## Known gaps: Claude Code cloud (planning agent)

- **The Anthropic API stays reachable,** even with network access set to None [1].
- **The GitHub proxy doesn't limit which branches a push updates** [2].
- **Scheduled tasks are in research preview** [3].

## What an enterprise would choose

| Choice | When it fits |
| --- | --- |
| Claude Code cloud on Team or Enterprise | Organization-shared environments, admin-managed network secrets, or self-hosted environments with egress at the company's own boundary [2] |
| Copilot cloud agent | Default for GitHub Enterprise shops; GitHub says its firewall is not a complete security solution [8] |
| Coder (self-hosted) | Teams that already run dev environments on their own infra; Agent Firewall needs Premium [18] |
| E2B or Daytona BYOC | Platform teams building their own agent runners; E2B BYOC starts at $3,000/mo [12] |
| AWS Bedrock AgentCore in a VPC | AWS-centric, compliance-heavy shops; a domain allowlist needs Network Firewall, about $288/mo per endpoint [19][20] |

## Not verified

- Copilot's credential handling.
- Docker Sandboxes' GitHub token injection.
- Daytona's isolation technology and secret handling.
- Ona's agent egress controls.
- Whether Coder's Agent Firewall denies by default.

## Sources

1. [Claude Code in the cloud](https://code.claude.com/docs/en/claude-code-on-the-web)
2. [Configure cloud environments](https://code.claude.com/docs/en/cloud-environments)
3. [Scheduled tasks](https://code.claude.com/docs/en/routines)
4. [Claude pricing](https://claude.com/pricing)
5. [Unable to push GitHub Actions workflows (workflow scope)](https://kb.databricks.com/dev-tools/unable-to-push-github-actions-workflows-from-a-databricks-repository)
6. [Harden-Runner](https://github.com/step-security/harden-runner)
7. [Claude Code GitHub Actions](https://code.claude.com/docs/en/github-actions)
8. [Customize the Copilot agent firewall](https://docs.github.com/en/copilot/how-tos/use-copilot-agents/coding-agent/customize-the-agent-firewall)
9. [Docker Sandboxes](https://docs.docker.com/ai/sandboxes/)
10. [Docker Sandboxes security defaults](https://docs.docker.com/ai/sandboxes/security/defaults/)
11. [trailofbits/claude-code-devcontainer](https://github.com/trailofbits/claude-code-devcontainer)
12. [E2B internet access](https://docs.e2b.dev/network/internet-access.md) and [E2B pricing](https://e2b.dev/pricing)
13. [Cloudflare Containers pricing](https://developers.cloudflare.com/containers/pricing/)
14. [Cloudflare Sandbox outbound traffic](https://developers.cloudflare.com/sandbox/guides/outbound-traffic/)
15. [Security in GitHub Codespaces](https://docs.github.com/en/codespaces/reference/security-in-github-codespaces)
16. [Daytona network limits](https://www.daytona.io/docs/en/network-limits)
17. [Modal sandbox networking](https://modal.com/docs/guide/sandbox-networking)
18. [Coder agent boundaries](https://coder.com/docs/ai-coder/agent-boundaries)
19. [AWS AgentCore pricing](https://aws.amazon.com/bedrock/agentcore/pricing/)
20. [AWS Network Firewall pricing](https://aws.amazon.com/network-firewall/pricing/)
