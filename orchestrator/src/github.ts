const API = "https://api.github.com";

/** GitHub gives up on a webhook after 10 seconds, and a release makes three calls. */
const CALL_TIMEOUT_MS = 3000;

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

/** Mint an installation token limited to one repo, and refuse one that isn't. */
export async function mintInstallationToken(
  env: Env,
  installationId: number,
  repo: string,
): Promise<string> {
  if (!env.GITHUB_APP_ID || !env.GITHUB_APP_PRIVATE_KEY) {
    throw new GitHubError("GITHUB_APP_ID or GITHUB_APP_PRIVATE_KEY is not set");
  }
  const jwt = await appJwt(env.GITHUB_APP_ID, env.GITHUB_APP_PRIVATE_KEY);
  const name = repo.slice(repo.indexOf("/") + 1);
  const response = await call(`/app/installations/${installationId}/access_tokens`, "POST", jwt, {
    repositories: [name],
  });
  if (!response.ok) {
    throw new GitHubError(`Minting a token returned ${response.status}`);
  }
  const minted = (await response.json()) as {
    token?: string;
    repositories?: { full_name?: string }[];
  };
  if (!minted.token) {
    throw new GitHubError("The minted token response has no token");
  }
  const scope = minted.repositories ?? [];
  if (scope.length !== 1 || scope[0]?.full_name?.toLowerCase() !== repo.toLowerCase()) {
    await revokeToken(minted.token);
    throw new GitHubError("The minted token isn't limited to the one repo");
  }
  return minted.token;
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

export async function commentOnIssue(
  token: string,
  repo: string,
  issue: number,
  body: string,
): Promise<void> {
  const response = await call(`/repos/${repo}/issues/${issue}/comments`, "POST", token, { body });
  if (!response.ok) {
    throw new GitHubError(`Commenting returned ${response.status}`);
  }
}

/** Best effort: an unrevoked token expires within the hour. */
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
