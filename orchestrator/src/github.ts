const API = "https://api.github.com";

/**
 * Runs make these calls from their alarm, not from the webhook, so they can wait
 * longer. A 3-second limit, from when the webhook made them, likely lost a status
 * comment's id in #9's first run.
 */
const CALL_TIMEOUT_MS = 15_000;

/** Never includes a response body or a credential, because it goes to the logs. */
export class GitHubError extends Error {}

function call(path: string, method: string, credential: string, body?: unknown): Promise<Response> {
  return fetch(`${API}${path}`, {
    method,
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${credential}`,
      "Content-Type": "application/json",
      "User-Agent": "secure-agent-workflow",
      "X-GitHub-Api-Version": "2022-11-28",
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(CALL_TIMEOUT_MS),
  });
}

function base64url(bytes: Uint8Array | string): string {
  const data = typeof bytes === "string" ? new TextEncoder().encode(bytes) : bytes;
  return btoa(String.fromCharCode(...data))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");
}

/** WebCrypto imports only PKCS#8. setup-secrets.sh converts GitHub's PKCS#1 key. */
function importPrivateKey(pem: string): Promise<CryptoKey> {
  const match = pem.match(/-----BEGIN PRIVATE KEY-----([\s\S]+?)-----END PRIVATE KEY-----/);
  if (!match?.[1]) {
    throw new GitHubError("GITHUB_APP_PRIVATE_KEY is not a PKCS#8 PEM");
  }
  const der = Uint8Array.from(atob(match[1].replace(/\s/g, "")), (c) => c.charCodeAt(0));
  return crypto.subtle.importKey("pkcs8", der, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, [
    "sign",
  ]);
}

/** An App JWT: RS256, 10-minute ceiling, iat backdated a minute for clock drift. */
export async function appJwt(appId: string, pem: string, now = Date.now()): Promise<string> {
  const seconds = Math.floor(now / 1000);
  const claims = { iat: seconds - 60, exp: seconds + 540, iss: appId };
  const unsigned = `${base64url(JSON.stringify({ alg: "RS256", typ: "JWT" }))}.${base64url(JSON.stringify(claims))}`;
  const key = await importPrivateKey(pem);
  const signature = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    key,
    new TextEncoder().encode(unsigned),
  );
  return `${unsigned}.${base64url(new Uint8Array(signature))}`;
}

export interface RunToken {
  value: string;
  expiresAt: number;
}

/** A token for one run, limited by the repo's id so a rename can't redirect it. */
export async function mintRunToken(
  env: Env,
  installationId: number,
  repoId: number,
): Promise<RunToken> {
  if (!env.GITHUB_APP_ID || !env.GITHUB_APP_PRIVATE_KEY) {
    throw new GitHubError("GITHUB_APP_ID or GITHUB_APP_PRIVATE_KEY is not set");
  }
  const jwt = await appJwt(env.GITHUB_APP_ID, env.GITHUB_APP_PRIVATE_KEY);
  const response = await call(`/app/installations/${installationId}/access_tokens`, "POST", jwt, {
    repository_ids: [repoId],
  });
  if (!response.ok) {
    throw new GitHubError(`Minting a token returned ${response.status}`);
  }
  const minted = (await response.json()) as {
    token?: string;
    expires_at?: string;
    repositories?: { id?: number }[];
  };
  const expiresAt = Date.parse(minted.expires_at ?? "");
  if (!minted.token || Number.isNaN(expiresAt)) {
    throw new GitHubError("The minted token response has no token or expiry");
  }
  const scope = minted.repositories ?? [];
  if (scope.length !== 1 || scope[0]?.id !== repoId) {
    await revokeToken(minted.token);
    throw new GitHubError("The minted token isn't limited to the one repo");
  }
  return { value: minted.token, expiresAt };
}

/** Returns the new comment's id, so it can be edited later. */
export async function commentOnIssue(
  token: string,
  repo: string,
  issue: number,
  body: string,
): Promise<number> {
  const response = await call(`/repos/${repo}/issues/${issue}/comments`, "POST", token, { body });
  if (!response.ok) {
    throw new GitHubError(`Commenting returned ${response.status}`);
  }
  const created = (await response.json()) as { id?: unknown };
  if (typeof created.id !== "number") throw new GitHubError("The comment response has no id");
  return created.id;
}

export async function editComment(token: string, repo: string, id: number, body: string): Promise<void> {
  const response = await call(`/repos/${repo}/issues/comments/${id}`, "PATCH", token, { body });
  if (!response.ok) {
    throw new GitHubError(`Editing a comment returned ${response.status}`);
  }
}

/** The id of the first comment on the issue that contains `marker`, if any. */
export async function findComment(
  token: string,
  repo: string,
  issue: number,
  marker: string,
): Promise<number | undefined> {
  const response = await call(`/repos/${repo}/issues/${issue}/comments?per_page=100`, "GET", token);
  if (!response.ok) {
    throw new GitHubError(`Listing comments returned ${response.status}`);
  }
  const comments = (await response.json()) as { id?: unknown; body?: unknown }[];
  const found = comments.find((comment) => typeof comment.body === "string" && comment.body.includes(marker));
  return typeof found?.id === "number" ? found.id : undefined;
}

/** Adds or removes one label. Removing a label that isn't there isn't an error. */
export async function setLabel(
  token: string,
  repo: string,
  issue: number,
  label: string,
  present: boolean,
): Promise<void> {
  const response = present
    ? await call(`/repos/${repo}/issues/${issue}/labels`, "POST", token, { labels: [label] })
    : await call(`/repos/${repo}/issues/${issue}/labels/${encodeURIComponent(label)}`, "DELETE", token);
  if (!response.ok && !(response.status === 404 && !present)) {
    throw new GitHubError(`${present ? "Adding" : "Removing"} a label returned ${response.status}`);
  }
}

export async function getIssue(
  token: string,
  repo: string,
  issue: number,
): Promise<{ title: string; body: string }> {
  const response = await call(`/repos/${repo}/issues/${issue}`, "GET", token);
  if (!response.ok) {
    throw new GitHubError(`Reading the issue returned ${response.status}`);
  }
  const data = (await response.json()) as { title?: unknown; body?: unknown };
  return {
    title: typeof data.title === "string" ? data.title : "",
    body: typeof data.body === "string" ? data.body : "",
  };
}

/** Best effort: an unrevoked token expires within the hour. */
/**
 * The issues blocking this one, from GitHub's issue dependencies, as
 * "owner/name#number" in lower case. They can be in other repos.
 */
export async function getBlockers(token: string, repo: string, issue: number): Promise<string[]> {
  const response = await call(`/repos/${repo}/issues/${issue}/dependencies/blocked_by?per_page=100`, "GET", token);
  if (!response.ok) throw new GitHubError(`Reading the issue's blockers returned ${response.status}`);
  const data = (await response.json()) as { number?: unknown; repository_url?: unknown }[];
  if (!Array.isArray(data)) throw new GitHubError("The issue's blockers weren't a list");
  return data.flatMap((blocker) => {
    const repoName = typeof blocker.repository_url === "string" ? /\/repos\/([^/]+\/[^/]+)$/.exec(blocker.repository_url)?.[1] : undefined;
    return typeof blocker.number === "number" && repoName ? [`${repoName.toLowerCase()}#${blocker.number}`] : [];
  });
}

/** True only if GitHub says the repo is private. Anything else counts as public. */
export async function isPrivateRepo(token: string, repo: string): Promise<boolean> {
  const response = await call(`/repos/${repo}`, "GET", token);
  if (!response.ok) return false;
  const data = (await response.json()) as { private?: unknown };
  return data.private === true;
}

export async function revokeToken(token: string): Promise<void> {
  try {
    const response = await call("/installation/token", "DELETE", token);
    if (!response.ok) {
      console.error(`Revoking a token returned ${response.status}`);
    }
  } catch (error) {
    console.error(`Revoking a token failed: ${(error as Error).name}`);
  }
}
