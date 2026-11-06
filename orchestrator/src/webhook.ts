import { runnerFor } from "./agents";
import { GitHubError } from "./github";
import type { RunScope } from "./outbound/scope";
import { issueKey, MAX_RUNS, type BlockedRecord } from "./run";

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
}

/** What the approver did, which the orchestrator acts on. */
export type Action =
  | { kind: "release"; target: Target }
  | { kind: "stop"; target: Target; by: string }
  | { kind: "reply"; target: Target; by: string; body: string };

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
    return `action ${payload?.action}`;
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
  if (kind !== "release" && kind !== "stop" && kind !== "reply") return kind;

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
  const target: Target = { repo, repoId, defaultBranch, number, installationId, labels };
  if (kind === "reply") {
    const body = payload?.comment?.body;
    if (typeof body !== "string") return "comment has no body";
    return { kind, target, by: sender.login, body };
  }
  if (kind === "stop") return { kind, target, by: sender.login };
  return { kind, target };
}

function scopeOf(target: Target, runId: string): RunScope {
  return {
    runId,
    installationId: target.installationId,
    repoId: target.repoId,
    repo: target.repo,
    issue: target.number,
    defaultBranch: target.defaultBranch,
  };
}

function json(status: number, body: object): Response {
  return Response.json(body, { status });
}

type Log = DurableObjectStub<import("./deliveries").DeliveryLog>;

async function release(target: Target, delivery: string, env: Env, log: Log): Promise<Response> {
  // A run is named by its delivery id, and an issue has one active run at a time, so
  // relabeling while a run is live doesn't start a second.
  const scope = scopeOf(target, delivery);
  if (!(await log.claimIssue(issueKey(scope), delivery))) {
    return json(200, { ignored: "a run is already active on this issue" });
  }
  // A new release starts over, so an older blocked run can't be resumed after it, and
  // the issue's model budget is whole again.
  await log.clearBlocked(issueKey(scope));
  await log.clearIssueSpend(issueKey(scope));
  const runner = runnerFor(target.labels);
  try {
    await env.RUN_STATE.getByName(delivery).launch(scope, runner.name);
  } catch (error) {
    await log.releaseIssue(issueKey(scope), delivery);
    throw error;
  }
  console.log(`Released ${target.repo}#${target.number} to ${runner.name} from delivery ${delivery}`);
  return json(202, { released: `${target.repo}#${target.number}`, runner: runner.name });
}

/**
 * Stops the issue's active run, and clears a blocked one so a later reply can't
 * resume it. The run writes its stop flag before anything else.
 */
async function stop(target: Target, by: string, env: Env, log: Log): Promise<Response> {
  const key = `${target.repoId}#${target.number}`;
  const run = await log.activeRun(key);
  const wasBlocked = (await log.takeBlocked(key)) !== null;
  const stopped = run ? await env.RUN_STATE.getByName(run).halt(by) : false;
  if (!stopped && !wasBlocked) return json(200, { ignored: "nothing to stop on this issue" });
  console.log(`Stopped ${target.repo}#${target.number}${run ? ` (run ${run})` : ""} for ${by}`);
  return json(202, { stopped: `${target.repo}#${target.number}`, run: stopped ? run : null, cleared: wasBlocked });
}

/** The approver's reply on a blocked issue, or on its PR, starts a fresh run from the branch. */
async function resume(target: Target, reply: string, delivery: string, env: Env, log: Log): Promise<Response> {
  const key = await log.findBlocked(target.repoId, target.number);
  if (!key) return json(200, { ignored: "no blocked run to resume" });
  const raw = await log.takeBlocked(key);
  if (!raw) return json(200, { ignored: "no blocked run to resume" });
  const record = JSON.parse(raw) as BlockedRecord;
  const scope: RunScope = { ...record.scope, runId: delivery };
  if (!(await log.claimIssue(issueKey(scope), delivery))) {
    await log.markBlocked(key, record.scope.repoId, record.pr?.number ?? null, raw);
    return json(200, { ignored: "a run is already active on this issue" });
  }
  try {
    await env.RUN_STATE.getByName(delivery).launch(scope, record.runner, {
      branch: record.branch,
      pr: record.pr,
      reply,
      runNumber: record.runNumber + 1,
    });
  } catch (error) {
    await log.releaseIssue(issueKey(scope), delivery);
    await log.markBlocked(key, record.scope.repoId, record.pr?.number ?? null, raw);
    throw error;
  }
  console.log(`Resumed ${scope.repo}#${scope.issue}, run ${record.runNumber + 1} of ${MAX_RUNS}, from delivery ${delivery}`);
  return json(202, { resumed: `${scope.repo}#${scope.issue}`, run: record.runNumber + 1 });
}

export async function handleWebhook(request: Request, env: Env): Promise<Response> {
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

  try {
    if (action.kind === "release") return await release(action.target, delivery, env, log);
    if (action.kind === "stop") return await stop(action.target, action.by, env, log);
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
