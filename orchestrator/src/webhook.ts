import { commentOnIssue, GitHubError, mintInstallationToken, revokeToken } from "./github";

const RELEASE_LABEL = "agent:ready";

export interface Release {
  repo: string;
  issue: number;
  installationId: number;
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
  if (typeof issue !== "number" || typeof installationId !== "number") {
    return "payload is missing the issue or installation";
  }
  return { repo, issue, installationId };
}

/**
 * Proves the path from release to a GitHub write. #9 replaces this with starting
 * a run. The token is revoked here because nothing else uses it.
 */
async function acknowledge(release: Release, delivery: string, env: Env): Promise<void> {
  const token = await mintInstallationToken(env, release.installationId, release.repo);
  try {
    await commentOnIssue(
      token,
      release.repo,
      release.issue,
      `Release received by the orchestrator (build \`${env.BUILD_ID}\`, delivery \`${delivery}\`). ` +
        "Agent runs aren't built yet, so no run started.",
    );
  } finally {
    await revokeToken(token);
  }
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

  try {
    await acknowledge(decision, delivery, env);
  } catch (error) {
    // Forget the claim so redelivering from GitHub's log tries again. GitHubError
    // messages are safe to log; anything else logs only its type.
    await log.forget(delivery);
    const reason = error instanceof GitHubError ? error.message : (error as Error).name;
    console.error(`Release ${delivery} failed: ${reason}`);
    return json(502, { error: "release failed", delivery });
  }
  console.log(`Released ${decision.repo}#${decision.issue} from delivery ${delivery}`);
  return json(202, { released: `${decision.repo}#${decision.issue}` });
}
