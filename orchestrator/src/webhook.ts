import { runnerFor } from "./agents";
import type { RunScope } from "./outbound/scope";
import { issueKey } from "./run";

const RELEASE_LABEL = "agent:ready";

export interface Release {
  repo: string;
  repoId: number;
  defaultBranch: string;
  issue: number;
  installationId: number;
  /** The issue's labels when it was released. agent:probe picks the probe. */
  labels: string[];
}

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

/**
 * Whether a webhook releases an issue. Returns the release, or the reason it
 * doesn't. Only the approver releases: the agent App has issues:write, so it can
 * add this label too (ADR-005).
 */
export function decide(event: string | null, payload: any, rules: Rules): Release | string {
  if (event !== "issues") return `event ${event}`;
  if (payload?.action !== "labeled") return `action ${payload?.action}`;
  if (payload?.label?.name !== RELEASE_LABEL) return "another label";

  const sender = payload?.sender;
  if (!rules.approver || sender?.login?.toLowerCase() !== rules.approver.toLowerCase()) {
    return "sender isn't the approver";
  }
  if (sender?.type !== "User") return "sender isn't a user account";

  const repo = payload?.repository?.full_name;
  if (typeof repo !== "string" || !rules.allowedRepos.includes(repo.toLowerCase())) {
    return "repo isn't allowed";
  }
  if (payload?.issue?.state !== "open") return "issue isn't open";

  const issue = payload?.issue?.number;
  const installationId = payload?.installation?.id;
  const repoId = payload?.repository?.id;
  const defaultBranch = payload?.repository?.default_branch;
  if (
    typeof issue !== "number" ||
    typeof installationId !== "number" ||
    typeof repoId !== "number" ||
    typeof defaultBranch !== "string"
  ) {
    return "payload is missing the issue, installation or repo";
  }
  const labels = Array.isArray(payload?.issue?.labels)
    ? payload.issue.labels.map((label: { name?: unknown }) => label?.name).filter((name: unknown) => typeof name === "string")
    : [];
  return { repo, repoId, defaultBranch, issue, installationId, labels };
}

function scopeOf(release: Release, delivery: string): RunScope {
  return {
    runId: delivery,
    installationId: release.installationId,
    repoId: release.repoId,
    repo: release.repo,
    issue: release.issue,
    defaultBranch: release.defaultBranch,
  };
}

function json(status: number, body: object): Response {
  return Response.json(body, { status });
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

  const decision = decide(request.headers.get("X-GitHub-Event"), payload, {
    approver: env.APPROVER_LOGIN,
    allowedRepos: parseRepos(env.ALLOWED_REPOS),
  });
  if (typeof decision === "string") {
    return json(200, { ignored: decision });
  }

  const delivery = request.headers.get("X-GitHub-Delivery");
  if (!delivery || delivery.length > 64) {
    return json(400, { error: "bad delivery id" });
  }
  const log = env.DELIVERY_LOG.getByName("global");
  if (!(await log.claim(delivery))) {
    return json(200, { ignored: "duplicate delivery" });
  }

  // A run is named by its delivery id, and an issue has one active run at a time, so
  // relabeling while a run is live doesn't start a second.
  const scope = scopeOf(decision, delivery);
  if (!(await log.claimIssue(issueKey(scope), delivery))) {
    return json(200, { ignored: "a run is already active on this issue" });
  }

  const runner = runnerFor(decision.labels);
  try {
    await env.RUN_STATE.getByName(delivery).launch(scope, runner.name);
  } catch (error) {
    // Forget both claims so redelivering from GitHub's log tries again. Only the
    // error's type is logged.
    await log.releaseIssue(issueKey(scope), delivery);
    await log.forget(delivery);
    console.error(`Release ${delivery} failed: ${(error as Error).name}`);
    return json(502, { error: "release failed", delivery });
  }
  console.log(`Released ${decision.repo}#${decision.issue} to ${runner.name} from delivery ${delivery}`);
  return json(202, { released: `${decision.repo}#${decision.issue}`, runner: runner.name });
}
