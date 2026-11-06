/**
 * The operator's identity, from the Cloudflare Access JWT (ADR-010). The orchestrator
 * checks it on every /api/* request itself, so the console Worker that forwards
 * requests holds no authority, and /api/* on the orchestrator's own hostname, which
 * Access doesn't cover, gets nothing without a valid token.
 */

export type Identity = { ok: true; email: string } | { ok: false; reason: string };

interface Jwk extends JsonWebKey {
  kid?: string;
}

/** Keys are cached, and refetched for an unknown key id at most this often. */
const KEYS_TTL_MS = 10 * 60 * 1000;
const REFETCH_MS = 60 * 1000;
/** Allowed clock difference for `nbf`. Expiry gets none. */
const SKEW_S = 30;
const TEAM = /^[a-z0-9-]+$/;

const cache = new Map<string, { keys: Jwk[]; at: number }>();

function base64url(part: string): Uint8Array {
  const base64 = part.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(part.length / 4) * 4, "=");
  return Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
}

function decode(part: string): Record<string, unknown> | null {
  try {
    const value = JSON.parse(new TextDecoder().decode(base64url(part))) as unknown;
    return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

async function keys(team: string, kid: string, now: number): Promise<Jwk | undefined> {
  const cached = cache.get(team);
  const found = cached?.keys.find((key) => key.kid === kid);
  const fresh = cached && now - cached.at < KEYS_TTL_MS;
  if (found && fresh) return found;
  if (cached && now - cached.at < REFETCH_MS) return found;
  const response = await fetch(`https://${team}.cloudflareaccess.com/cdn-cgi/access/certs`);
  if (!response.ok) return found;
  const body = (await response.json()) as { keys?: unknown };
  const list = Array.isArray(body.keys) ? (body.keys as Jwk[]) : [];
  cache.set(team, { keys: list, at: now });
  return list.find((key) => key.kid === kid);
}

/**
 * The verified email, or why the request was refused. Unset settings refuse
 * everything.
 */
export async function verifyAccess(request: Request, env: Env, now = Date.now()): Promise<Identity> {
  const team = env.ACCESS_TEAM ?? "";
  const audience = env.ACCESS_AUD ?? "";
  const operator = (env.OPERATOR_EMAIL ?? "").trim().toLowerCase();
  if (!TEAM.test(team) || !audience || !operator) return { ok: false, reason: "Access isn't configured" };

  const token = request.headers.get("Cf-Access-Jwt-Assertion");
  if (!token) return { ok: false, reason: "no Access token" };
  const parts = token.split(".");
  if (parts.length !== 3) return { ok: false, reason: "malformed token" };
  const [head, body, signature] = parts as [string, string, string];
  const header = decode(head);
  const claims = decode(body);
  if (!header || !claims) return { ok: false, reason: "malformed token" };
  // Only RS256: never "none", and never a key the token names itself.
  if (header.alg !== "RS256" || typeof header.kid !== "string") return { ok: false, reason: "unexpected algorithm" };

  let key: Jwk | undefined;
  try {
    key = await keys(team, header.kid, now);
  } catch {
    return { ok: false, reason: "couldn't read Access's keys" };
  }
  if (!key) return { ok: false, reason: "unknown signing key" };
  let valid = false;
  try {
    const imported = await crypto.subtle.importKey(
      "jwk",
      key,
      { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
      false,
      ["verify"],
    );
    valid = await crypto.subtle.verify(
      "RSASSA-PKCS1-v1_5",
      imported,
      base64url(signature),
      new TextEncoder().encode(`${head}.${body}`),
    );
  } catch {
    valid = false;
  }
  if (!valid) return { ok: false, reason: "bad signature" };

  const seconds = Math.floor(now / 1000);
  const aud = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (!aud.includes(audience)) return { ok: false, reason: "wrong audience" };
  if (claims.iss !== `https://${team}.cloudflareaccess.com`) return { ok: false, reason: "wrong issuer" };
  if (typeof claims.exp !== "number" || claims.exp <= seconds) return { ok: false, reason: "expired" };
  if (typeof claims.nbf === "number" && claims.nbf > seconds + SKEW_S) return { ok: false, reason: "not yet valid" };
  const email = typeof claims.email === "string" ? claims.email.trim().toLowerCase() : "";
  if (email !== operator) return { ok: false, reason: "not the operator" };
  return { ok: true, email };
}
