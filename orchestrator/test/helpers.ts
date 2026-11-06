import { env, SELF } from "cloudflare:test";
import { vi } from "vitest";

export const SECRET = "test-webhook-secret";

export async function sign(body: string, secret = SECRET): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body));
  const hex = [...new Uint8Array(mac)].map((b) => b.toString(16).padStart(2, "0")).join("");
  return `sha256=${hex}`;
}

/** A release that passes every check. Tests change one field at a time. */
export function release(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    action: "labeled",
    label: { name: "agent:ready" },
    sender: { login: "the-approver", type: "User" },
    repository: { full_name: "the-approver/app", id: 1234, default_branch: "main" },
    issue: { number: 7, state: "open" },
    installation: { id: 99 },
    ...overrides,
  };
}

export async function deliver(
  payload: unknown,
  options: { event?: string; delivery?: string; signature?: string | null } = {},
): Promise<Response> {
  const body = typeof payload === "string" ? payload : JSON.stringify(payload);
  const signature = options.signature === undefined ? await sign(body) : options.signature;
  const headers: Record<string, string> = {
    "X-GitHub-Event": options.event ?? "issues",
    "X-GitHub-Delivery": options.delivery ?? crypto.randomUUID(),
  };
  if (signature !== null) headers["X-Hub-Signature-256"] = signature;
  return SELF.fetch("https://orchestrator.test/webhook", { method: "POST", headers, body });
}

export interface Call {
  method: string;
  url: string;
  authorization: string | null;
  body: unknown;
}

/**
 * Stand-in for GitHub. Records calls; `mint` overrides the token response, and
 * `comments` is what listing an issue's comments returns.
 */
export function stubGitHub(mint?: () => Response, comments: { id: number; body: string }[] = []): Call[] {
  const calls: Call[] = [];
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const request = new Request(input, init);
    const text = await request.text();
    calls.push({
      method: request.method,
      url: request.url,
      authorization: request.headers.get("Authorization"),
      body: text ? JSON.parse(text) : undefined,
    });
    if (request.url.endsWith("/access_tokens")) {
      if (mint) return mint();
      return Response.json(
        {
          token: "minted-token",
          expires_at: new Date(Date.now() + 3600_000).toISOString(),
          repositories: [{ id: 1234, full_name: "the-approver/app" }],
        },
        { status: 201 },
      );
    }
    if (request.method === "GET" && /\/issues\/\d+\/comments\?/.test(request.url)) return Response.json(comments);
    if (request.url.endsWith("/comments")) return Response.json({ id: 1 }, { status: 201 });
    if (request.method === "PATCH" && /\/issues\/comments\/\d+$/.test(request.url)) {
      return Response.json({ id: 1 });
    }
    if (request.method === "GET" && /\/issues\/\d+$/.test(request.url)) {
      return Response.json({ title: "Add a parser", body: "Parse the config file." });
    }
    if (request.url.endsWith("/installation/token")) return new Response(null, { status: 204 });
    return new Response("unexpected", { status: 500 });
  });
  return calls;
}

export function testEnv(): Env & { TEST_PUBLIC_KEY: string } {
  return env as unknown as Env & { TEST_PUBLIC_KEY: string };
}
