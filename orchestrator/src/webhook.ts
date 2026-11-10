import { nameKey, pumpQueue, queueCatchUps, queueRelease, type KnownRepo, type QueueEntry } from "./coordinator";
import { GitHubError, mintRunToken, revokeToken } from "./github";
import { MAX_RUNS, type BlockedRecord } from "./run";

const RELEASE_LABEL = "agent:ready";
const STOP_LABEL = "agent:stop";

/** The issue a webhook is about, with what a run needs from the payload. */
export interface Target {
  repo: string;
  repoId: number;
  defaultBranch: string;
  /** The issue's number, or the PR's for a comment on a PR. */
  number: number;
  installationId: number;
  /** The issue's labels when the event happened. agent:probe picks the probe. */
  labels: string[];
  /** The issue's title and body when the event happened: what a release approves. */
  title: string;
  body: string;
}

/** What the approver did, which the orchestrator acts on. */
export type Action =
  | { kind: "release"; target: Target }
  | { kind: "stop"; target: Target; by: string }
  | { kind: "reply"; target: Target; by: string; body: string }
  /** The approver closed an issue: done for the issues it blocks if completed (#13). */
  | { kind: "closed"; target: Target; completed: boolean }
  /** A PR closed. Trusted for what GitHub says happened, whoever sent it (#13). */
  | {
      kind: "pr-closed";
      repo: string;
      repoId: number;
      pr: number;
      mergedIntoDefault: boolean;
      installationId: number | null;
      defaultBranch: string;
    };

export interface Rules {
  approver: string;
  allowedRepos: string[];
}

/**
 * Checks X-Hub-Signature-256 against the raw body. crypto.subtle.verify compares
 * in constant time, which `===` on the hex strings wouldn't.
 */
export async function verifySignature(
  secret: string,
  body: ArrayBuffer,
  header: string | null,
): Promise<boolean> {
  const hex = header?.match(/^sha256=([0-9a-f]{64})$/)?.[1];
  if (!hex) return false;
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["verify"],
  );
  const signature = Uint8Array.from(hex.match(/../g) ?? [], (byte) => parseInt(byte, 16));
  return crypto.subtle.verify("HMAC", key, signature, body);
}

export function parseRepos(list: string): string[] {
  return list
    .split(",")
    .map((repo) => repo.trim().toLowerCase())
    .filter(Boolean);
}

/** Which action an event is, before checking who sent it. */
function classify(event: string | null, payload: any): Action["kind"] | string {
  if (event === "issues") {
    const label = payload?.label?.name;
    if (payload?.action === "labeled") {
      if (label === RELEASE_LABEL) return "release";
      if (label === STOP_LABEL) return "stop";
      return "another label";
    }
    if (payload?.action === "unlabeled") {
      // Removing agent:ready stops the run. Removing any other label, agent:blocked
      // included, does nothing: only the approver's reply resumes a run (#11).
      return label === RELEASE_LABEL ? "stop" : "another label";
    }
    if (payload?.action === "closed") return "closed";
    return `action ${payload?.action}`;
  }
  if (event === "pull_request") {
    return payload?.action === "closed" ? "pr-closed" : `action ${payload?.action}`;
  }
  if (event === "issue_comment") {
    return payload?.action === "created" ? "reply" : `action ${payload?.action}`;
  }
  return `event ${event}`;
}

/**
 * What a webhook asks for, or the reason it's ignored. Only the approver acts: the
 * agent App has issues:write, so it can add these labels and comment too (ADR-005).
 */
export function decide(event: string | null, payload: any, rules: Rules): Action | string {
  const kind = classify(event, payload);
  if (kind === "pr-closed") return decidePullRequest(payload, rules);
  if (kind !== "release" && kind !== "stop" && kind !== "reply" && kind !== "closed") return kind;

  const sender = payload?.sender;
  if (!rules.approver || sender?.login?.toLowerCase() !== rules.approver.toLowerCase()) {
    return "sender isn't the approver";
  }
  if (sender?.type !== "User") return "sender isn't a user account";

  const repo = payload?.repository?.full_name;
  if (typeof repo !== "string" || !rules.allowedRepos.includes(repo.toLowerCase())) {
    return "repo isn't allowed";
  }
  if (kind === "release" && payload?.issue?.state !== "open") return "issue isn't open";

  const number = payload?.issue?.number;
  const installationId = payload?.installation?.id;
  const repoId = payload?.repository?.id;
  const defaultBranch = payload?.repository?.default_branch;
  if (
    typeof number !== "number" ||
    typeof installationId !== "number" ||
    typeof repoId !== "number" ||
    typeof defaultBranch !== "string"
  ) {
    return "payload is missing the issue, installation or repo";
  }
  const labels = Array.isArray(payload?.issue?.labels)
    ? payload.issue.labels.map((label: { name?: unknown }) => label?.name).filter((name: unknown) => typeof name === "string")
    : [];
  const title = typeof payload?.issue?.title === "string" ? payload.issue.title : "";
  const issueBody = typeof payload?.issue?.body === "string" ? payload.issue.body : "";
  const target: Target = { repo, repoId, defaultBranch, number, installationId, labels, title, body: issueBody };
  if (kind === "closed") {
    // A PR is an issue too, but its closing comes through pull_request events.
    if (payload?.issue?.pull_request) return "a PR, not an issue";
    return { kind, target, completed: payload?.issue?.state_reason === "completed" };
  }
  if (kind === "reply") {
    const body = payload?.comment?.body;
    if (typeof body !== "string") return "comment has no body";
    return { kind, target, by: sender.login, body };
  }
  if (kind === "stop") return { kind, target, by: sender.login };
  return { kind, target };
}

/**
 * A closed PR in an allowed repo. Anyone can send this: what counts is GitHub's own
 * record that it merged, and the coordinator acts only on PRs its runs opened.
 */
function decidePullRequest(payload: any, rules: Rules): Action | string {
  const repo = payload?.repository?.full_name;
  if (typeof repo !== "string" || !rules.allowedRepos.includes(repo.toLowerCase())) return "repo isn't allowed";
  const repoId = payload?.repository?.id;
  const pr = payload?.pull_request?.number;
  if (typeof repoId !== "number" || typeof pr !== "number") return "payload is missing the PR or repo";
  const merged = payload?.pull_request?.merged === true;
  const defaultBranch = typeof payload?.repository?.default_branch === "string" ? payload.repository.default_branch : "";
  const intoDefault = defaultBranch !== "" && payload?.pull_request?.base?.ref === defaultBranch;
  const installationId = typeof payload?.installation?.id === "number" ? payload.installation.id : null;
  return { kind: "pr-closed", repo, repoId, pr, mergedIntoDefault: merged && intoDefault, installationId, defaultBranch };
}

function json(status: number, body: object): Response {
  return Response.json(body, { status });
}

type Log = DurableObjectStub<import("./deliveries").DeliveryLog>;

async function release(target: Target, delivery: string, env: Env): Promise<Response> {
  // A run is named by its delivery id. The issue enters the queue, which starts it
  // when a slot, its areas and its blockers allow (ADR-005).
  const released = await queueRelease(target, delivery, env);
  if (!released.queued) return json(200, { ignored: released.reason });
  console.log(`Released ${target.repo}#${target.number} to ${released.runner} from delivery ${delivery}${released.started ? "" : ", queued"}`);
  return json(202, {
    released: `${target.repo}#${target.number}`,
    runner: released.runner,
    started: released.started,
    waiting: released.waiting,
  });
}

/**
 * Stops the issue: takes it out of the queue, stops its active run, and clears a
 * blocked one so a later reply can't resume it. Its areas are freed (ADR-005). The
 * run writes its stop flag before anything else.
 */
async function stop(target: Target, by: string, env: Env, log: Log): Promise<Response> {
  const key = `${target.repoId}#${target.number}`;
  const dequeued = await log.dequeue(key);
  const run = await log.activeRun(key);
  const wasBlocked = (await log.takeBlocked(key)) !== null;
  const stopped = run ? await env.RUN_STATE.getByName(run).halt(by) : false;
  if (!stopped && !wasBlocked && !dequeued) return json(200, { ignored: "nothing to stop on this issue" });
  console.log(`Stopped ${target.repo}#${target.number}${run ? ` (run ${run})` : ""} for ${by}`);
  // Freed areas can let a queued issue start.
  await pumpQueue(env);
  return json(202, { stopped: `${target.repo}#${target.number}`, run: stopped ? run : null, cleared: wasBlocked, dequeued });
}

/**
 * The approver's reply on a blocked issue, or on its PR, queues a fresh run from the
 * branch, ahead of new issues.
 */
async function resume(target: Target, reply: string, delivery: string, env: Env, log: Log): Promise<Response> {
  const key = await log.findBlocked(target.repoId, target.number);
  if (!key) return json(200, { ignored: "no blocked run to resume" });
  const raw = await log.takeBlocked(key);
  if (!raw) return json(200, { ignored: "no blocked run to resume" });
  const record = JSON.parse(raw) as BlockedRecord;
  const entry: QueueEntry = {
    issue: key,
    run: delivery,
    kind: "resume",
    scope: record.scope,
    runner: record.runner,
    resume: { branch: record.branch, pr: record.pr, reply, runNumber: record.runNumber + 1 },
    // A run blocked before the queue existed has no snapshot. Its issue is read
    // when the run starts, and it locks every area of the repo.
    snapshot: record.snapshot ?? { title: "", body: "", blockers: [], areas: [] },
  };
  const queued = await log.enqueue(entry);
  if (!queued.queued) {
    await log.markBlocked(key, record.scope.repoId, record.pr?.number ?? null, raw);
    return json(200, { ignored: queued.reason });
  }
  const started = (await pumpQueue(env)).includes(delivery);
  console.log(`Resumed ${record.scope.repo}#${record.scope.issue}, run ${record.runNumber + 1} of ${MAX_RUNS}, from delivery ${delivery}`);
  return json(202, { resumed: `${record.scope.repo}#${record.scope.issue}`, run: record.runNumber + 1, started });
}

/**
 * The approver closed an issue. Closed as completed, it's done for the issues it
 * blocks. Either way it leaves the queue.
 */
async function closed(target: Target, completed: boolean, env: Env, log: Log): Promise<Response> {
  const dequeued = await log.dequeue(`${target.repoId}#${target.number}`);
  if (completed) await log.markCompleted(nameKey(target.repo, target.number), "closed by the approver");
  await pumpQueue(env);
  return json(202, { closed: `${target.repo}#${target.number}`, completed, dequeued });
}

/** A run's PR closed: its areas are free, and a merge completes its issue. */
async function pullRequestClosed(
  action: Extract<Action, { kind: "pr-closed" }>,
  env: Env,
  log: Log,
  ctx?: ExecutionContext,
): Promise<Response> {
  // Any merge into the default branch can make a run's open PR conflict. GitHub
  // works out mergeability after the merge, so the check waits a little (#111).
  if (action.mergedIntoDefault && action.installationId !== null && ctx) {
    const repo = { name: action.repo, repoId: action.repoId, defaultBranch: action.defaultBranch, installationId: action.installationId };
    ctx.waitUntil(checkCatchUps(env, repo));
  }
  const issue = await log.pullRequestClosed(action.repoId, action.pr, action.mergedIntoDefault);
  if (!issue) return json(200, { ignored: "not a run's PR" });
  await pumpQueue(env);
  return json(202, { pr: `${action.repo}#${action.pr}`, issue, completed: action.mergedIntoDefault });
}

/** How long after a merge to check for conflicts. The reconciler catches anything later. */
const CATCH_UP_DELAY_MS = 20_000;

async function checkCatchUps(env: Env, repo: KnownRepo): Promise<void> {
  try {
    await scheduler.wait(CATCH_UP_DELAY_MS);
    const token = await mintRunToken(env, repo.installationId, repo.repoId);
    try {
      await queueCatchUps(env, repo, token.value);
    } finally {
      await revokeToken(token.value);
    }
    await pumpQueue(env);
  } catch (error) {
    console.error(`Checking for catch-ups failed: ${error instanceof GitHubError ? error.message : (error as Error).name}`);
  }
}

export async function handleWebhook(request: Request, env: Env, ctx?: ExecutionContext): Promise<Response> {
  if (!env.GITHUB_WEBHOOK_SECRET) {
    console.error("GITHUB_WEBHOOK_SECRET is not set");
    return json(500, { error: "not configured" });
  }

  // The signature covers these exact bytes, so verify before parsing them.
  const body = await request.arrayBuffer();
  const signature = request.headers.get("X-Hub-Signature-256");
  if (!(await verifySignature(env.GITHUB_WEBHOOK_SECRET, body, signature))) {
    return json(401, { error: "bad signature" });
  }

  let payload: unknown;
  try {
    payload = JSON.parse(new TextDecoder().decode(body));
  } catch {
    return json(400, { error: "body isn't JSON" });
  }

  const action = decide(request.headers.get("X-GitHub-Event"), payload, {
    approver: env.APPROVER_LOGIN,
    allowedRepos: parseRepos(env.ALLOWED_REPOS),
  });
  if (typeof action === "string") {
    return json(200, { ignored: action });
  }

  const delivery = request.headers.get("X-GitHub-Delivery");
  if (!delivery || delivery.length > 64) {
    return json(400, { error: "bad delivery id" });
  }
  const log = env.DELIVERY_LOG.getByName("global");
  if (!(await log.claim(delivery))) {
    return json(200, { ignored: "duplicate delivery" });
  }
  // The reconciler covers the repos webhooks came from (#110).
  const repository = (payload as { repository?: { id?: unknown; full_name?: unknown; default_branch?: unknown } }).repository;
  const installation = (payload as { installation?: { id?: unknown } }).installation;
  if (
    typeof repository?.id === "number" &&
    typeof repository.full_name === "string" &&
    typeof repository.default_branch === "string" &&
    typeof installation?.id === "number"
  ) {
    await log.recordRepo(repository.id, repository.full_name, installation.id, repository.default_branch);
  }

  try {
    if (action.kind === "release") return await release(action.target, delivery, env);
    if (action.kind === "stop") return await stop(action.target, action.by, env, log);
    if (action.kind === "closed") return await closed(action.target, action.completed, env, log);
    if (action.kind === "pr-closed") return await pullRequestClosed(action, env, log, ctx);
    return await resume(action.target, action.body, delivery, env, log);
  } catch (error) {
    // Forget the claim so redelivering from GitHub's log tries again. GitHubError
    // messages are safe to log; anything else logs only its type.
    await log.forget(delivery);
    const reason = error instanceof GitHubError ? error.message : (error as Error).name;
    console.error(`Delivery ${delivery} (${action.kind}) failed: ${reason}`);
    return json(502, { error: `${action.kind} failed`, delivery });
  }
}
