# Design review and prioritized recommendations

Date: 2026-11-01 · Local baseline: `7107c06` · Reviewer: Codex

## Where each recommendation is tracked

Added by the maintainer on 2026-11-01. The review below is unchanged. The R1, R2, R7 and R9 findings marked confirmed were re-checked locally before filing.

| Item | Tracked in | Decision |
| --- | --- | --- |
| R1 | #60 Require the gate on this repo's own PRs | Adopted; before any agent works in this repo |
| R2 | #61 Stop PRs from weakening the gate's scans and tiers | Adopted; before the first unattended merge |
| R3 | Comments on #11 and #13 | Check spend before each run and call; per-run cap for the pilot, full reservation ledger once concurrency goes above 1 |
| R4 | Comment on #8 | Adopted |
| R5 | Comment on #13 | Adopted |
| R6 | #18 (Cloudflare deploy template), comment on #49 | Adopted: build without credentials, deploy from a separate job, preview Worker with its own bindings |
| R7 | Tier map in #61; the rest before concurrency goes above 1 | Adopted |
| R8 | Comments on #33 and #34 | Adopted; artifact attestation moved from #18 to #34 |
| R9 | #62 Fail credential checks that produce no evidence | Adopted |
| R10 | Comment on #34 | Adopted; before production releases |
| R11 | First orchestrator wave | Adopted |

Ordering differs from the suggested sequence below: #18 continues now, since nothing merges unattended until the orchestrator issues (#7 to #13) land. #60, #61 and #62 come before the first agent-run merge.

## Assessment

The architecture has a sound foundation: separate agent identity, external enforcement, pinned reusable workflows, environment-specific broker roles, and a clear distinction between instructions and controls. Keep those choices. The main weakness is the distance between a stated security property and the complete mechanism needed to enforce it. Some gaps are in implemented controls; others need decisions before the orchestrator and deployment pipeline are built.

My recommendation is to harden the existing gate and its own source repository, implement a narrow capability boundary and budget ledger, then prove one useful issue through staging. Keep concurrency at one. Defer the console, broad model routing and richer coordination until that slice produces measured results.

**Budget assumption, confirmed by the operator:** $30/month includes LLM usage. Budget builder, reviewer, retries, escalation, planning automation, CI overages, factory hosting, broker/storage, and incremental preview/staging hosting. Any newly required subscription also consumes that budget. Existing subscriptions do not make separately billed API tokens free. If consumer production hosting is charged separately, explicitly identify that boundary rather than leaving costs implicit.

## Scope and evidence

Reviewed the system spec, ADRs 001–009, research, standards and workflow-loop plan; bootstrap and App manifests; gate workflows, scripts and tests; broker IAM/CloudFormation; credential tooling and checker; and the relevant open GitHub issues, including #7–13, #18, #21, #33 and #49. Read the live repository ruleset and merge settings through authenticated, read-only GitHub API calls. No GitHub settings, issues, branches or cloud resources were changed.

Evidence labels used below:

- **Confirmed:** directly observed in local code, a local probe, or the live API.
- **Design gap:** an incomplete contract in a component not yet built; not a claim of an existing exploit.
- **Needs testbed:** a plausible failure requiring a disposable live environment to establish its end-to-end impact.

`make check` passes: 36 gate tests, 50 credential tests, and tracked shell syntax checks. Local probes additionally exercised SARIF handling, tier classification, checker output, gitleaks suppression and release ancestry. They used synthetic values and temporary directories. Existing testbed results in the repository were read, not independently rerun. I did not perform a sandbox escape test, exercise real cloud permissions, or inspect secret values.

## Priority order

P0 means fix the current enforcement gap first. P1 means complete before unattended use of the affected capability. P2 means complete before the named later milestone.

| Rank | Priority | Recommendation | Evidence | When / existing work |
| --- | --- | --- | --- | --- |
| R1 | P0 | Enforce the gate on this platform repository | Confirmed live | Now; bootstrap/self-hosting |
| R2 | P1 | Make scanner policy trusted and missing evidence fail | Confirmed local | Before unattended merges; gate |
| R3 | P1 | Enforce a monthly dollar budget, reserving spend before requests | Design gap | Before paid runs; #11, #13, ADR-008 |
| R4 | P1 | Complete the proxy's run-specific capability contract | Design gap | Before #9; extend #8 |
| R5 | P1 | Bind dispatch and dependency completion to trusted evidence | Design gap | Before wave dispatch; #7, #13 |
| R6 | P1 | Treat preview code as having the authority of its credentials and bindings | Confirmed grants; design gap | Before #18 and #49 |
| R7 | P1 | Bind gate decisions to the exact tested revision and control changes in risk | Confirmed behavior; needs testbed | Before unattended merges/parallelism |
| R8 | P2 | Fix release ancestry and define artifact promotion | Confirmed local; design gap | Before #33 and #34 |
| R9 | P2 | Make credential verification distinguish success from no evidence | Confirmed local | Before relying on credential health alerts |
| R10 | P2 | Define N-1 compatibility and operational rollback precisely | Design gap | Before data-changing production releases |
| R11 | P2 | Start with a smaller pilot and measure useful autonomy | Design recommendation | First orchestrator wave |

## R1. Enforce the gate on the repository that supplies the controls

**Confirmed live.** `GET /repos/danjamk/secure-agent-workflow/rulesets/26205412` returned active `protect-default`, no bypass actors, and only these rules:

```text
non_fast_forward
deletion
required_linear_history
pull_request: required_approving_review_count = 0
```

There was no `required_status_checks` rule. The repository's gate workflow runs on PRs, but this ruleset does not require it to pass. The ruleset also does not require code-owner review. The local `tier-check.yml` is a reusable workflow with `workflow_call`; this repository has no PR-triggered tier caller. A writer can therefore satisfy the visible merge rules with an unchecked PR. This is a current enforcement gap, independent of the future orchestrator.

**Improve:** add a dedicated self-check caller and require the appropriate gate checks plus tier enforcement. Give the self-caller a different filename from the reusable tier workflow. Do not blindly install the consumer template over `.github/workflows/tier-check.yml`: that path already hosts the reusable implementation here. For PRs changing control code, execute the authoritative tier policy from an approved revision while running candidate code tests separately.

Until self-hosting is verified, a simple owner-review requirement is a reasonable temporary control. Keep the eventual zero-touch tier 1 behavior where intended. SHA pins already protect consumers from automatically taking a changed upstream gate; this finding does not mean existing consumer pins silently change.

**Done when:** a failing PR cannot merge here; a bot's tier 3 PR cannot merge even with approval; a tier 2 bot PR waits for the owner's current-head approval. Add a read-only control-drift check so the active settings cannot silently diverge from the desired settings again.

## R2. Protect scanner policy and require actual scan evidence

**Confirmed local.** `.github/workflows/gate-checks.yml` invokes gitleaks in the candidate repository without disabling inline allowances. Installed gitleaks was **8.30.1**, matching `gate/tools.txt`. With the workflow's scan flags, a synthetic high-entropy `api_key` assignment returned exit 1. The same assignment with `# gitleaks:allow` returned exit 0. Its `src/example.py` path is tier 1. An agent can therefore weaken an authoritative scan through code it is allowed to merge without approval.

Gitleaks documents both inline allowances and ignore/configuration inputs. Semgrep also documents inline suppression and ignore inputs; its exact pinned-container behavior was not executed in this review. [Gitleaks documentation](https://github.com/gitleaks/gitleaks#configuration), [Semgrep ignore behavior](https://docs.semgrep.dev/ignoring-files-folders-code).

**Also confirmed:** `gate/sarif_gate.py` exits 0 for both an existing empty directory and a file containing `{}`. No scan evidence is interpreted as zero findings. This is a robustness gap, not proof that a PR can force CodeQL to produce those outputs. `test_empty_sarif_passes` currently accepts an empty run list.

**Improve:**

- Load scanner policy and approved exceptions from the pinned gate or trusted base revision. Disable candidate inline suppressions, or fail until new suppressions receive explicit review. For gitleaks, validate the pinned version's `--ignore-gitleaks-allow` option and use an explicit trusted configuration/ignore path.
- Audit every scanner's candidate config, ignore, baseline, symlink and suppression inputs. Include test paths in that review; security scanners commonly exclude them by default.
- Pin the Semgrep rule bundle, or explicitly accept and monitor upstream rule drift. A pinned binary with a live `p/default` bundle is only partly reproducible.
- Require expected SARIF files, valid run/tool structure and successful invocation status. An empty `results` list in a valid successful run is different from no run. Keep “language not applicable” an explicit workflow result.

**Done when:** the synthetic secret still blocks with an inline allowance, unauthorized ignore/config changes block, and absent/malformed/incomplete scanner output fails. Add these cases to the red-team suite, including the private-repo scanner path.

## R3. Turn $30/month into admission control, not a reporting target

**Design gap.** ADR-005 totals reported spend per day and lets active runs finish within their budgets. ADR-008 defaults escalation on. Neither mechanism establishes a $30 monthly total, and observing tokens after a response cannot bound the cost of concurrent or in-flight requests. A token limit also needs model-specific prices to become a dollar limit. Reviewer calls live outside the builder proxy and must consume the same overall budget.

**Improve:** maintain an atomic monthly ledger in trusted storage: settled spend, outstanding reservations and non-LLM allowance. Before a model request, reserve a conservative maximum input/output cost, including supported cache/reasoning/tool charges. Reject calls that cannot fit. Settle against provider usage; retain a conservative charge for requests with ambiguous billing rather than refunding immediately. Reserve reviewer and bounded recovery costs before starting a build. Keep daily and per-run limits as additional controls.

Route or account for every paid path: builder subprocesses, escalation, resume/catch-up, audit, readiness reviews, release reviews, and any automated planning/retro calls. Unknown model pricing or an unmetered endpoint should stop admission. Teardown must cancel active work and prevent new proxy calls; disconnecting a client may not undo provider charges. Provider caps are backstops only where their actual semantics are verified.

### Initial operating envelope

These are proposed allocations, not measured expenses:

| Envelope | Monthly amount | Includes |
| --- | ---: | --- |
| Non-LLM allowance | $10 | Workers plan, sandbox compute, DO/log storage, broker, incremental targets, CI overages |
| LLM allowance | $15 | All automated builder, reviewer and planning work |
| Unallocated buffer | $5 | Billing uncertainty and recovery |
| Total | **$30** | No automatic spending of the buffer |

Cloudflare currently lists a $5 Workers Paid base with included container usage; Workers, Durable Objects and logs also contribute charges. The $10 envelope must be checked against actual instance hours and other accounts, not assumed sufficient. [Cloudflare pricing](https://developers.cloudflare.com/containers/platform/pricing/).

For scale only, at the documented Sonnet 4.6 rates of $3/M input and $15/M output, 200k uncached input plus 20k output costs $0.90; 1M plus 100k costs $4.50, before review or retries. These are hypothetical usage examples, not model recommendations or run forecasts. Caching can change them. [Anthropic pricing](https://platform.claude.com/docs/en/about-claude/pricing).

At a $15 LLM allowance, ten merged PRs permit $1.50 each including failures and reviews. Validate that target with real runs. Default automatic escalation off for the pilot, and enable it only with a reserved dollar ceiling. Cache audit results by head/base/policy/model revision, bound context, and rerun only when inputs materially change. Do not save money by treating an unavailable required audit as passing.

**Done when:** near the monthly limit, simultaneous requests cannot over-admit; a retry and reviewer call share the same ceiling; ambiguous usage stays charged conservatively; and the digest shows remaining total budget plus the expected cost of the next queued job. Reconcile the ledger to provider invoices.

## R4. Make the proxy a run-specific capability boundary

**Design gap, partly addressed already.** Issue #8 explicitly includes REST filtering, parsed GraphQL mutations, restricted label writes and git push parsing. Issue #7 already scopes installation tokens to one repo. Keep those requirements; the remaining gap is object-level authorization and protocol completeness.

The current design permits pushes to `agent/*`. That is broader than “this run's branch.” Likewise, an allowed “issues/comments/PR” endpoint family does not identify which objects or fields a run may change. The App's permissions are a ceiling, not the intended per-run capability set.

**Improve:** bind every authenticated request to installation, immutable repository ID, run generation, exact branch, issue and PR. Allow only enumerated operations on those objects. Deny ref updates through alternate REST/GraphQL routes, edits to other issues, closing blockers, review submission, direct merging and mutation of another run's PR. Expose auto-merge and ready-for-review as fixed, validated operations where possible. GraphQL operation names alone are insufficient: aliases, fragments, batched operations and object IDs need validation. A small trusted bridge for writes can reduce the parser surface.

Constrain model traffic too: allowed models/endpoints, output ceilings, paid tools, concurrent requests and price mapping. Avoid a generic credential injector for an entire vendor host. Verify redirects and header forwarding do not move credentials to an unintended origin. All paths must check stop status before admission.

**Done when:** adversarial requests cannot modify another run's branch, abuse a human-authored PR, close a dependency, call an unbudgeted model, or continue new requests after stop. The branch ownership rule is especially important because `tier_check.decide()` accepts an approver-authored PR without a review, regardless of who later supplies its branch contents. That exemption is intentional; its safety depends on who can update the head.

Before choosing SDK APIs, pin and test the intended Cloudflare SDK version. The design's outbound link currently documents SDK 0.x and directs new applications to the newer API. This is a version decision, not a reason by itself to change sandbox provider. [Cloudflare outbound guide](https://developers.cloudflare.com/sandbox/sdk/guides/outbound-traffic/).

## R5. Separate GitHub presentation state from trusted authorization state

**Design gap.** ADR-005 carefully snapshots blockers, area and run profile, but starts dependents when an issue is closed as `completed`. The App has `issues: write`; the proxy's planned “issues” access must prevent direct completion from becoming trusted merge evidence. Issue #11 already correctly requires an owner reply for resume and says arbitrary label removal does nothing.

Three contracts still need to be explicit:

1. **Dispatch provenance:** reconciliation must recover missed webhooks without trusting the current presence of a label. Record an owner-authenticated dispatch, or reconstruct actor provenance from an appropriate event source and fail closed when it is unavailable. Include a dispatch generation so an old delivery cannot restart stopped work.
2. **Approved work:** snapshot issue content and relevant plan/ADR revisions at dispatch. Later agent edits must not change the assignment or what the conformance reviewer regards as approved intent. Record operator amendments explicitly.
3. **Completion:** a dependency is satisfied by a recorded PR merged into the intended base, or a distinct operator-authorized external completion. Closing a GitHub issue alone is insufficient.

Implement durable transitions and idempotency for slot reservation, sandbox creation, teardown and callbacks. Include crashes between steps, duplicate deliveries, blocked/resumed runs, PR closure without merge, reopened work and stale callbacks. Reconcile abandoned slots and locks. Area locks reduce planned conflicts; they do not enforce file scope. At concurrency one this is simpler to prove.

The App manifest currently subscribes to `issues`, `issue_comment` and `pull_request`, but not `push`; ADR-005's catch-up-on-main-push path needs a subscription update or an explicitly polled equivalent.

**Done when:** agent closure cannot unblock dependent work; a missed dispatch is recovered with actor evidence; duplicate/stale deliveries cannot create extra runs; and a simulated coordinator crash cannot leak a slot or permanently strand an area lock.

## R6. Reduce preview authority and classify state as secret-bearing

**Confirmed grants; design gap.** `deploy/broker/aws/repo.yml` grants the preview role `s3:GetObject` over dev state and reads under `/<repo>/dev/preview/*`. ADR-006 acknowledges that provider and external-source code can execute during planning. The spec accepts that candidate build scripts see preview credentials. This is a deliberate transfer of authority to agent-written code, even though the sandbox itself has no tokens.

Read-only infrastructure state may contain passwords and other resource attributes. Encryption at rest does not hide them from an authorized reader. [OpenTofu guidance](https://opentofu.org/docs/language/state/sensitive-data/).

The existing design also uses version preview URLs and shared dev bindings. Cloudflare now distinguishes Version URLs from isolated Previews; its documentation says Version URLs use the configured production resources for that version, while resource IDs shared between Previews still share data. Here the deployed dev Worker's “production” resources correspond to this project's staging resources, not the separate prod target. [Workflow comparison](https://developers.cloudflare.com/workers/previews/compare-workflows/), [resource isolation](https://developers.cloudflare.com/workers/previews/resources/).

**Improve:**

- Build candidate code without cloud credentials. Pass the resulting artifact into a separate trusted deploy job which does not run repository build/install hooks with deploy authority.
- Make infrastructure planning a distinct, least-privileged job. Treat state read access as secret access. For the pilot, keep state and dev data free of valuable secrets; later decide whether full state access is acceptable or requires a more constrained planning boundary.
- Use synthetic preview data and explicitly isolated resources/bindings. Native Previews are worth evaluating, but shared IDs and broad account credentials still need a boundary. If account-wide deploy authority remains, document preview/staging compromise as accepted dev-target risk rather than claiming preview isolation.
- Do not let runtime credentials delivered to a preview reach a real third-party production account. Include bindings, service bindings and third-party keys in the exposure inventory, not just SSM paths.

**Done when:** a malicious test build cannot read deploy credentials; a preview cannot alter staging data or privileged services beyond explicitly accepted access; and an infrastructure-plan fixture cannot read a synthetic staging-only secret through state or the broker. If isolation cannot be delivered cheaply, use a disposable dev target for the initial pilot.

## R7. Bind each gate verdict to a revision and close tier-map gaps

**Confirmed implementation choices.** `tier_check.main()` fetches the PR's current head through the API, then separately fetches files and reviews. The workflow does not provide an expected event head/base for comparison. An old run may evaluate newer state, and calls may observe different revisions. No end-to-end bypass was demonstrated, but the verdict-to-check attribution contract is incomplete.

Bootstrap sets `strict_required_status_checks_policy` to false. Conflict catch-ups only handle a `dirty` merge state, not two individually passing changes that combine into a broken build. A green run against an old base is not evidence for the current combined tree.

**Improve:** provide expected head/base and trusted workflow/policy revisions, verify them at the beginning and end, and refuse to emit a green verdict if inputs changed. Serialize/cancel obsolete work where useful, but do not rely on cancellation alone for correctness. Before raising concurrency, require up-to-date checks or another tested mechanism that validates the actual merge candidate.

**Also confirmed locally:** the tier map currently yields:

| Path | Tier | Implication |
| --- | ---: | --- |
| `infra/dev/main.tf` | 2 | Safe default for an unmatched path |
| `infra/modules/README.md` | 1 | Broad Markdown allowance overrides the intended infrastructure category |
| `src/infra/main.tf` | 1 | Source allowance covers infrastructure code |
| `src/infra/.terraform.lock.hcl` | 1 | Source allowance covers provider lockfile |
| `src/authentication.ts` | 1 | Naming/placement can evade `auth/**` categorization |

Issue #49 already plans the `infra/**`, `**/*.tf`, `**/*.tofu` and lockfile rules. Bring those rules forward before adopting the broker/manifest pattern, and test precedence under broad tier 1 paths. This is known planned work with observable current consequences, not an overlooked requirement in #49.

Path tiers are an operational heuristic for expected risk. They cannot establish that arbitrary source changes are low-risk. Map sensitive consumer modules explicitly, review additions to the risk map, and use the future audit as supplementary judgment rather than a proof of semantic safety. Missing language coverage must be visible; audit the reference build's actual languages before enabling zero-touch merges.

**Done when:** pushes during a tier run cannot produce a verdict for mixed revisions; two nonconflicting but incompatible PRs cannot merge on stale tests; all declared infrastructure patterns classify correctly under `src/` and Markdown allowances.

## R8. Preserve release ancestry and promote a fixed artifact

**Confirmed local incompatibility.** Bootstrap globally enables squash merge and disables merge commits/rebase. Issue #33 proposes repeated PRs from long-lived `main` into long-lived `production` without changing that merge policy. In a temporary Git repo, after squash-promoting release one, the second `production...main` comparison included both release one's file and release two's file. Squash does not establish the expected ancestry between the two branches. This pollutes release diffs and the evidence used by release review.

**Improve:** retain squash for feature PRs into `main`, but use ancestry-preserving merge commits for promotion into `production`, with compatible repository settings and branch-specific enforcement. Production must allow those merge commits. Alternatively redesign promotion around immutable release references and an explicit previous-release comparison; do not leave the history semantics implicit. [GitHub merge semantics](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/configuring-pull-request-merges/about-merge-methods-on-github).

Define an immutable release manifest: source SHA, artifact digest, trusted build workflow revision, infrastructure plan identity and target environment. Reject a release when `main` advanced after approval or regenerate the release evidence and require fresh approval. A build attestation identifies provenance; it does not establish that an arbitrary uploaded artifact satisfies the reviewed intent. Verify the expected builder and subject digest at deployment.

**Done when:** two consecutive releases show only the newly shipped changes; the deployed artifact is the reviewed source artifact; and main advancing after approval cannot silently change the release batch. Extend #33/#34 rather than adding another release subsystem.

## R9. Make credential health fail when verification produces no evidence

**Confirmed local.** `parse_check('', 0)` returns no failures and no identity. Passing that result to `evaluate()` produces `PASS ... checks pass; no expiry`. A broken checker that exits successfully without doing anything can therefore look healthy. Identity is optional in the protocol, and an absent recorded identity does not by itself prevent this PASS. The Cloudflare checker normally emits evidence; this is a contract/extension failure mode.

The daily workflow's manifest lookup also treats every failed `gh api` lookup as “no manifest,” including authorization failures and outages. That conflates an intentionally absent manifest with an unobserved one.

**Improve:** require explicit positive verification evidence for a checked credential, with a versioned checker result and an identity requirement for systems that support it. Distinguish checked, unchecked, identity unknown and failed. Fail manifest lookup on errors other than a confirmed not-found response. Preserve the useful existing factory-account rejection, account matching, masked inputs and manual unchecked-storage acknowledgment. Capability probes should continue to be described as selected checks, not proof of least privilege.

**Done when:** blank output, a malformed result, a missing required identity, API outage and confirmed missing manifest each produce the intended distinct outcome. Test daily issue creation/recovery for these cases.

## R10. Test rollback compatibility, not only migration syntax

**Design gap.** ADR-009 is directionally right: decide data compatibility before release, record a rollback target, and rehearse it. Two details need refinement before production:

- The standards classify every contract as one-way, while the requirement is compatibility with N-1. A removal can remain N-1 compatible if the previous release no longer reads or writes it and platform rollback permits the operation. Conversely, an additive change can be semantically incompatible. Schema step and rollback direction should be related but independently justified. Treat uncertain platform migration behavior conservatively.
- Staging rollback exercises staging's previous deployed version. If staging has received many PRs since the last production release, that is not necessarily the production N-1 version. Rehearse the actual production predecessor against representative post-release data as well.

**Improve:** test old readers/writers against new data and new writers against old code; define dual-write/backfill ordering and message compatibility explicitly. Record the production predecessor's version/artifact and the resource/configuration changes rollback will not reverse. Keep deploys serialized per environment, verify health and relevant behavior, and rehearse partial failure between infrastructure apply, migration and code deploy. Keep destructive actions human-controlled.

A forward fix from current `main` can include unrelated unshipped changes. Record that trade-off and use flags or an explicitly reviewed batch; an expedited release is not automatically a small release.

**Done when:** a representative migration survives rollback to actual production N-1, or is explicitly marked one-way with a usable restore point and forward-fix procedure. The test should check data visibility and correctness, not only `/health`.

## R11. Prove a smaller system before expanding the operating process

The project already has a substantial planning and reporting loop for a personal platform with a very small cash budget. Its most valuable next evidence is a useful unattended delivery, its true cost, and a demonstrated stop. More templates and routing knobs cannot substitute for that evidence.

**Recommended pilot:** one disposable dev target, one repo, one CLI/model, concurrency one, a short owner-dispatched issue, the hardened gate, isolated build/deploy, basic logs, hard budgets, stop and owner-only resume. Build enough coordinator state for idempotency and spend reservation immediately. GitHub comments are sufficient for the first pilot; #13 currently depends on Slack #12, which can be decoupled by defining a minimal notifier interface. Keep module boundaries replaceable without building multi-vendor implementations yet.

The spec permits deterministic-only automatic merges before the LLM audit exists. During that period, limit unattended work to a disposable pilot or use temporary human approval for changes to a valuable reference build. Do not interpret a scanner-green application change as a security-reviewed change.

After three to five useful PRs, evaluate operator minutes, correctness, full cost per merged PR including rework, blocked-run reasons and whether the prescribed readiness process reduced interruptions. Permit ordinary implementation judgment; reserve operator questions for product decisions, expanded authority, material scope changes and irreversible actions. “No design choice left” is too strict as a literal readiness rule for a coding agent.

Give the planning agent's owner identity an explicit retirement trigger before unattended planning or production use. Keep the already documented accepted risk visible; do not count its reviews as an independent human checkpoint.

## Suggested implementation sequence

1. **Harden what exists:** R1 and R2; bring forward #49's tier patterns; add R9's small failure cases. Deliverable: current controls demonstrably block bad PRs.
2. **Prove authority and cost:** extend #8 with R4; extend #11/#13 with R3 and R5. Pin the SDK. Deliverable: a protocol-level spike demonstrating denied operations, reliable stop and bounded spend before adding full lifecycle automation.
3. **Deliver one useful issue through staging:** implement the R11 pilot with R6's build/deploy separation. Deliverable: a measured result plus published negative tests. Enable no broader autonomy until these pass.
4. **Add audit and calibrate:** implement #21, measure reviewer value and cost, and expand automatic merging only with evidence. Adopt R7's current-base validation before increasing concurrency.
5. **Prepare production:** complete R8/R10 with #33/#34, including two consecutive release rehearsals and actual N-1 recovery. Revisit planning identity before expanding its authority.

Prefer extending the existing issues and ADRs to creating a parallel backlog. Keep the App identity, account separation, OIDC broker, base-revision policy reads, single coordinator and explicit release approval. The recommendations tighten their contracts; they do not call for a platform rewrite.

## Reproducing the small local probes

Run from the repository root. These commands only read source and create temporary files:

```bash
make check
python3 - <<'PY'
import pathlib, subprocess, sys, tempfile
sys.path.insert(0, 'gate')
import tier_check
m = tier_check.parse_tier_map(pathlib.Path('standards/tier-map.yml').read_text())
for p in ('infra/modules/README.md', 'src/infra/main.tf',
          'src/infra/.terraform.lock.hcl', 'src/authentication.ts'):
    print(p, tier_check.tier_of(p, m)[0])
with tempfile.TemporaryDirectory() as d:
    print('empty directory exit:', subprocess.run(
        [sys.executable, 'gate/sarif_gate.py', d]).returncode)
    pathlib.Path(d, 'empty.sarif').write_text('{}')
    print('missing runs exit:', subprocess.run(
        [sys.executable, 'gate/sarif_gate.py', d]).returncode)
PY
```

For the gitleaks probe, initialize a temporary Git repo with a base commit, then add a synthetic high-entropy `api_key` assignment in `src/example.py`. Run `gitleaks git --log-opts=<base>..HEAD --redact --no-banner --exit-code 1 .`. Compare otherwise identical single-commit candidates with and without `# gitleaks:allow`. Version 8.30.1 returned 1 and 0 respectively. No real credential is necessary.

For release ancestry, initialize `main` and `production` at the same base, add a file to main, squash it into production, then add a second file to main. `git diff --name-only production...main` lists both files. All Git mutations in this review were confined to temporary repositories.

For live drift verification, read `gh api repos/danjamk/secure-agent-workflow/rulesets` and each returned rule's details. The live finding above is a dated observation; recheck after any settings update.
