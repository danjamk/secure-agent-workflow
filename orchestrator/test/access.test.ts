// Part of test:security. The /api routes accept only the operator's Cloudflare Access
// identity, checked by the orchestrator itself (ADR-010, #101).
import { env, runInDurableObject, SELF } from "cloudflare:test";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { verifyAccess } from "../src/access";
import type { RunState } from "../src/run";

afterEach(() => vi.restoreAllMocks());

const TEAM = "test-team";
const AUD = "test-aud";
const OPERATOR = "operator@example.com";
const CERTS = `https://${TEAM}.cloudflareaccess.com/cdn-cgi/access/certs`;
const settings = { ...env, ACCESS_TEAM: TEAM, ACCESS_AUD: AUD, OPERATOR_EMAIL: OPERATOR } as Env;

const algorithm = { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" };
let signing: CryptoKeyPair;
let other: CryptoKeyPair;
let jwk: JsonWebKey & { kid: string };

beforeAll(async () => {
  signing = (await crypto.subtle.generateKey(algorithm, true, ["sign", "verify"])) as CryptoKeyPair;
  other = (await crypto.subtle.generateKey(algorithm, true, ["sign", "verify"])) as CryptoKeyPair;
  jwk = { ...((await crypto.subtle.exportKey("jwk", signing.publicKey)) as JsonWebKey), kid: "key-1" };
});

/** Access's published keys. Counts fetches, and fails any other call. */
function stubCerts(): { fetches: () => number } {
  let fetches = 0;
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    const url = new Request(input).url;
    if (url === CERTS) {
      fetches += 1;
      return Response.json({ keys: [jwk] });
    }
    return new Response("unexpected", { status: 500 });
  });
  return { fetches: () => fetches };
}

const encode = (value: object | Uint8Array) =>
  btoa(String.fromCharCode(...(value instanceof Uint8Array ? value : new TextEncoder().encode(JSON.stringify(value)))))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");

async function token(
  claims: Record<string, unknown> = {},
  options: { key?: CryptoKey; header?: Record<string, unknown> } = {},
): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const head = encode({ alg: "RS256", kid: "key-1", typ: "JWT", ...options.header });
  const body = encode({
    aud: [AUD],
    email: OPERATOR,
    iss: `https://${TEAM}.cloudflareaccess.com`,
    iat: now,
    nbf: now,
    exp: now + 300,
    type: "app",
    ...claims,
  });
  const signature = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", options.key ?? signing.privateKey, new TextEncoder().encode(`${head}.${body}`));
  return `${head}.${body}.${encode(new Uint8Array(signature))}`;
}

const withToken = (jwt: string | null) =>
  new Request("https://orchestrator.test/api/runs/x/log", { headers: jwt ? { "Cf-Access-Jwt-Assertion": jwt } : {} });

describe("the Access check", () => {
  it("accepts the operator's token", async () => {
    stubCerts();
    expect(await verifyAccess(withToken(await token()), settings)).toEqual({ ok: true, email: OPERATOR });
    // Email case doesn't matter.
    expect((await verifyAccess(withToken(await token({ email: "Operator@Example.com" })), settings)).ok).toBe(true);
  });

  it.each([
    ["no token", async () => null, "no Access token"],
    ["a malformed token", async () => "not.a-token", "malformed token"],
    ["another identity", async () => token({ email: "someone@example.com" }), "not the operator"],
    ["a service token, which has no email", async () => token({ email: undefined, common_name: "svc" }), "not the operator"],
    ["another application's audience", async () => token({ aud: ["other-aud"] }), "wrong audience"],
    ["another team's issuer", async () => token({ iss: "https://evil.cloudflareaccess.com" }), "wrong issuer"],
    ["an expired token", async () => token({ exp: Math.floor(Date.now() / 1000) - 1 }), "expired"],
    ["a token not valid yet", async () => token({ nbf: Math.floor(Date.now() / 1000) + 3600 }), "not yet valid"],
    ["a token signed by another key", async () => token({}, { key: other.privateKey }), "bad signature"],
    ["an unknown key id", async () => token({}, { header: { kid: "key-9" } }), "unknown signing key"],
    ["alg none", async () => token({}, { header: { alg: "none" } }), "unexpected algorithm"],
    ["HS256", async () => token({}, { header: { alg: "HS256" } }), "unexpected algorithm"],
  ])("refuses %s", async (_name, make, reason) => {
    stubCerts();
    expect(await verifyAccess(withToken(await make()), settings)).toEqual({ ok: false, reason });
  });

  it("refuses everything when a setting is missing", async () => {
    stubCerts();
    const jwt = await token();
    for (const missing of ["ACCESS_TEAM", "ACCESS_AUD", "OPERATOR_EMAIL"] as const) {
      expect((await verifyAccess(withToken(jwt), { ...settings, [missing]: "" } as Env)).ok).toBe(false);
    }
    expect((await verifyAccess(withToken(jwt), { ...settings, ACCESS_TEAM: "evil.example/x" } as Env)).ok).toBe(false);
  });

  it("caches Access's keys", async () => {
    const { fetches } = stubCerts();
    const later = Date.now() + 11 * 60 * 1000;
    // A time past the cache's lifetime, so this test doesn't depend on the others.
    await verifyAccess(withToken(await token()), settings, later);
    await verifyAccess(withToken(await token()), settings, later + 1000);
    expect(fetches()).toBe(1);
  });
});

describe("the log route", () => {
  async function runWithLog(text: string): Promise<string> {
    const runId = crypto.randomUUID();
    await runInDurableObject(env.RUN_STATE.getByName(runId), async (_instance: RunState, state) => {
      state.storage.sql.exec("CREATE TABLE IF NOT EXISTS log (seq INTEGER PRIMARY KEY AUTOINCREMENT, source TEXT NOT NULL, text TEXT NOT NULL)");
      state.storage.sql.exec("INSERT INTO log (source, text) VALUES ('agent', ?)", text);
      await state.storage.put("logLines", 1);
    });
    return runId;
  }

  const get = async (path: string, jwt: string | null, method = "GET") =>
    SELF.fetch(`https://orchestrator.test${path}`, { method, headers: jwt ? { "Cf-Access-Jwt-Assertion": jwt } : {} });

  it("serves a run's log to the operator, as plain text that isn't rendered or cached", async () => {
    stubCerts();
    const runId = await runWithLog("<script>alert(1)</script>\n");
    const response = await get(`/api/runs/${runId}/log`, await token());
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("<script>alert(1)</script>\n");
    expect(response.headers.get("Content-Type")).toBe("text/plain; charset=utf-8");
    expect(response.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(response.headers.get("Content-Security-Policy")).toContain("default-src 'none'");
    expect(response.headers.get("Cache-Control")).toBe("no-store");
  });

  it("serves nothing without the operator's token, whatever the path", async () => {
    stubCerts();
    const runId = await runWithLog("secret-free but private\n");
    for (const jwt of [null, await token({ email: "someone@example.com" })]) {
      for (const path of [`/api/runs/${runId}/log`, "/api/anything"]) {
        const response = await get(path, jwt);
        expect(response.status).toBe(403);
        expect(await response.text()).toBe("Forbidden\n");
      }
    }
  });

  it("answers 404 for a run with no log or a bad id, and 405 for a write", async () => {
    stubCerts();
    const jwt = await token();
    expect((await get(`/api/runs/${crypto.randomUUID()}/log`, jwt)).status).toBe(404);
    expect((await get("/api/runs/bad%2Fid/log", jwt)).status).toBe(404);
    expect((await get(`/api/runs/${await runWithLog("x\n")}/log`, jwt, "POST")).status).toBe(405);
  });

  it("leaves the webhook to its own signature check", async () => {
    stubCerts();
    const response = await SELF.fetch("https://orchestrator.test/webhook", { method: "POST", body: "{}" });
    expect(response.status).not.toBe(403);
    expect(response.status).toBe(401);
  });
});
