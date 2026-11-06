/**
 * The console's Worker (#105). It serves /health, and forwards /api/* to the
 * orchestrator over the service binding. It has no authority of its own: the
 * orchestrator checks the operator's Access token on every request (ADR-010).
 */

export interface Env {
  ORCHESTRATOR: Fetcher;
  ASSETS: Fetcher;
  BUILD_ID: string;
}

const TOKEN_HEADER = "Cf-Access-Jwt-Assertion";
/** Access's cookie, which holds the same signed token as the header. */
const TOKEN_COOKIE = "CF_Authorization";

function cookie(request: Request, name: string): string | null {
  for (const part of (request.headers.get("Cookie") ?? "").split(";")) {
    const [key, ...value] = part.trim().split("=");
    if (key === name) return value.join("=") || null;
  }
  return null;
}

/**
 * The request as the browser sent it, minus its cookies. Access adds the token as
 * a header; if it's missing, the token from Access's cookie is used instead. Either
 * way the orchestrator verifies it, so this adds no trust.
 */
export async function forward(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const headers = new Headers(request.headers);
  const fromCookie = cookie(request, TOKEN_COOKIE);
  headers.delete("Cookie");
  if (!headers.has(TOKEN_HEADER) && fromCookie) headers.set(TOKEN_HEADER, fromCookie);
  // Read first: the orchestrator's writes take small JSON bodies.
  const body = request.method === "GET" || request.method === "HEAD" ? null : await request.arrayBuffer();
  const target = new URL(`${url.pathname}${url.search}`, "https://orchestrator.internal");
  return env.ORCHESTRATOR.fetch(new Request(target, { method: request.method, headers, body, redirect: "manual" }));
}

export default {
  async fetch(request, env): Promise<Response> {
    const { pathname } = new URL(request.url);
    if (pathname === "/health" && request.method === "GET") return new Response(env.BUILD_ID);
    if (pathname.startsWith("/api/")) return forward(request, env);
    return env.ASSETS.fetch(request);
  },
} satisfies ExportedHandler<Env>;
