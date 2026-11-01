# Design review plan

Date: 2026-11-01 · Baseline: `7107c06` · Status: initial analysis completed; see [findings and recommendations](design-review-2026-11-01.md)

## Understanding of the project

This is a small software delivery platform for unattended coding agents. A human approves the intent and dispatches work; agents implement it; independently enforced controls decide what can merge and deploy. Its product is both the enforcement machinery and the operating process around it: readiness, waves, review, releases and learning from runs.

The key architectural principle is that agent instructions describe desired behavior, while controls outside the agent enforce authority. Bootstrap establishes GitHub policy; a narrowly permissioned App supplies identity; the planned sandbox proxy mediates use of that identity; the gate classifies changes; the broker separates deployment authority by environment. Factory, dev target and prod target are distinct trust domains.

The local implementation covers bootstrap, deterministic scans, tier checks, the dev broker and credential maintenance. The orchestrator, sandbox mediation, LLM audit, actual deploy pipeline and production release path remain unbuilt. Documentation's recorded live results are useful evidence, but were not independently reproduced in this pass.

The first-pass reading covered the README, system spec, ADRs 001–009, component contracts, sandbox and identity research, workflow-loop plan, core standards, workflows, and the principal gate/bootstrap/broker/credential implementations. `make check` passed: 36 gate tests, 50 credential tests and tracked shell syntax checks. This establishes the local baseline; it does not establish end-to-end security.

## Review method

For each promise, record: protected asset, adversary capability, enforcement point, trusted inputs, bypass paths, executable evidence, and residual risk. Classify conclusions as implementation findings, design gaps, accepted trade-offs, or hypotheses needing a test. Avoid treating an unbuilt component as a defect merely because it is unbuilt.

Assume the build agent can intentionally misuse every exposed capability, including through arbitrary shell code, dependency installation and agent-written CI code. Treat the operator and platform foundation as trusted. Review the planning agent's owner identity as an explicitly accepted exception, with a condition for retiring it.

Prioritize design decisions that are expensive to reverse before cosmetic consistency or additional features. Prefer a failing testbed experiment over more prose when a security property depends on platform behavior.

## 1. Authority and trust boundaries — first priority

**Question:** Does every reachable operation have the intended authority, even when the credential itself is hidden?

- Write the outbound proxy contract before implementing the orchestrator. Specify allowed methods, repository IDs, run-owned branch and PR IDs, REST operations, GraphQL operations, request bodies, redirects and response handling. A host allowlist and an `agent/*` push rule alone do not specify these limits.
- Test alternate write paths: Git data and contents APIs, PR merge APIs, GraphQL aliases and multiple mutations, branch deletion, non-fast-forward updates, and writes to another run's branch or another installed repo. Scope each installation token to the intended repo.
- Test whether a human-authored PR with an agent-writable head branch can retain the tier check's author exemption after the agent changes its contents. `gate/tier_check.py:decide()` currently treats approver authorship as sufficient; the branch ownership contract must account for this.
- Define stop semantics for in-flight requests, streaming model responses, token revocation and sandbox teardown. State what can still finish after stop and the maximum delay.
- Separate credential confidentiality from delegated authority and source-data confidentiality. Allowed GitHub and model endpoints can still carry data outside the sandbox.

**Deliverable:** capability matrix and proxy contract, with negative tests for every forbidden operation. Complete the highest-risk protocol experiments before broad orchestrator work.

## 2. Trusted work and coordinator correctness

**Question:** Can mutable GitHub content become an authorization decision?

- ADR-005 snapshots blockers, area and profile, but the issue body and references also define the approved work. Decide whether dispatch snapshots their revisions, validates them against the merged plan, or deliberately permits later changes.
- The coordinator starts dependents when blockers are closed as `completed`, while the App has `issues: write`. Test an agent closing its blocker without a merged PR. Require trusted merge evidence if dependency completion is meant to mean merged work.
- Reconciliation must recover missed dispatch webhooks while retaining proof that the operator dispatched. A currently present `agent:ready` label alone cannot establish who added it. Specify the recovery source and fail-closed behavior.
- Define a state machine for queued, starting, running, blocked, review-waiting, stopped and completed work. Cover duplicate and out-of-order events, redelivery, crash between reservation and sandbox creation, stale run callbacks, reopened PRs and orphaned area locks.
- Bind operator replies to identity and run generation, including Slack-to-GitHub relays. Do not trust a bot-relayed statement merely because its text names the operator.

**Deliverable:** transition table, event identity rules, recovery protocol and fault-injection cases. Start with one repo and concurrency one, while retaining these invariants.

## 3. Gate integrity and what “green” proves

**Question:** Is the evidence authentic, current and sufficient for unattended merging?

- Verify the executing check is bound to the intended workflow revision and PR commit. Exercise concurrent pushes, base-branch movement, review submission/dismissal and reruns. Bootstrap currently sets `strict_required_status_checks_policy` to false; establish the intended policy for testing against the current base before enabling parallel runs.
- Audit scanner inputs as attacker-controlled files, including tool configuration, ignore files, suppression comments and symlinks. Binary pinning does not establish the integrity of scan policy. Decide which exceptions require review and which policy must come from trusted code.
- Test missing or empty scan outputs and unsupported languages. `sarif_gate.py` currently reports zero findings if a directory contains no SARIF files; decide when absence of output must fail.
- Challenge path-based risk classification. Security-sensitive behavior can live outside `auth/` and `permissions/`. Record which guarantees tiers provide and what still depends on tests, human review or the future audit.
- Exercise the tier check's current-head API reads against the workflow event SHA and check attribution. Include failures during pagination and changes between API calls.
- Treat LLM diversity as a review technique, with measured miss rates and adversarial fixtures. Define how the system behaves when the audit is unavailable or returns malformed findings.

**Deliverable:** gate assurance matrix and a small adversarial fixture suite. Distinguish merge authorization from evidence of functional correctness.

## 4. Credentials, preview execution and release safety

**Question:** What can agent-written code reach after leaving the sandbox?

- Trace preview execution through build scripts, plugins, providers, deploy tokens, Worker bindings, runtime secrets and dev state. Explicitly inventory which dev data and credentials are disposable and which are not.
- ADR-006 grants preview read access to dev OpenTofu state. State can contain secrets, so read-only access needs a data classification decision, not only an IAM decision. Review that before planning infrastructure for the reference build. [OpenTofu state guidance](https://opentofu.org/docs/language/state/sensitive-data/) confirms that resource attributes can include passwords.
- Test whether preview deployment authority can alter staging Workers, read bound storage, or change runtime behavior beyond the intended preview. Factory separation is valuable but does not establish preview/staging isolation.
- Preserve the credential checker's stated limit: successful probes demonstrate selected capabilities and account identity, not absence of excessive permission. Test manifest changes, missing identities, checker failures, rotation and reporting without exposing values.
- Specify exactly which artifact and source revision production promotes, how provenance is verified, and whether the reviewed batch can change between approval and deploy.
- Review rollback as an entire application compatibility operation: code, bindings, schema, dual writes, queued messages and infrastructure. Reconcile the “N-1 compatible” goal with deliberately one-way contract releases and their restore/forward-fix procedures.

**Deliverable:** credential/data exposure matrix and deployment sequence with explicit failure and recovery behavior. Production remains behind the existing staged build order.

## 5. Cost, usability and scope

**Question:** Does the smallest working system deliver useful autonomy at the stated operating cost?

- The operator confirmed that the $30 monthly goal is all-in, including LLM usage. Account for model API usage, audit calls, private-repo Actions minutes, storage and escalations. The sandbox research estimates compute separately from model tokens.
- Define budget accounting for streaming, concurrent requests, cancelled requests, retries, cache charges and failures before usage is reported. Reserve spend before admitting work where a hard ceiling is required; document any bounded overshoot.
- Measure time to a correct merged PR, operator minutes per wave, blocked-run rate, rollback time and total cost including rework. Ten zero-touch PRs should have a quality assessment as well as a merge count.
- Keep the first vertical slice narrow: one CLI/model, one repo, concurrency one, one useful low-risk issue through staging, observable logs and a reliable stop. Add routing and automation after measuring that path.
- Revisit readiness language that excludes nearly all agent design judgment. State which choices are implementation discretion and which require an operator decision, then use blocked-run evidence to refine it.

**Deliverable:** cost model and acceptance criteria for a pilot wave, followed by a short keep/simplify/defer recommendation.

## Evidence and access

Local code and public vendor documentation are enough to begin all five reviews. Cloudflare's linked outbound guide now redirects into its SDK 0.x documentation; establish the intended SDK version before relying on those APIs. [Cloudflare outbound documentation](https://developers.cloudflare.com/sandbox/sdk/guides/outbound-traffic/).

Read-only GitHub access would add the open issue backlog, testbed workflow runs, rulesets, App permissions and failed experiment logs. Ask for the smallest missing scope only when a specific check needs it. Cloud credentials and secret values are unnecessary for the design review. Adversarial mutations belong on explicitly authorized disposable testbeds.

The first review output should contain ranked findings, evidence and reproduction steps, the architectural decisions needed before orchestrator implementation, and a short list of experiments. Do not turn every observation into a new subsystem or ADR.
