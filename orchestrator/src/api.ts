import { verifyAccess } from "./access";

/** Delivery ids name runs, and they're UUIDs. */
const RUN_ID = /^[A-Za-z0-9-]{1,64}$/;

/**
 * Read routes for the operator (#101), reached through the console Worker. Every
 * request is checked against the Access JWT before anything else, so an
 * unauthenticated caller can't tell which paths exist.
 */
export async function handleApi(request: Request, env: Env): Promise<Response> {
  const identity = await verifyAccess(request, env);
  if (!identity.ok) {
    // The reason only, never the token.
    console.warn(JSON.stringify({ api: "refused", reason: identity.reason }));
    return text("Forbidden\n", 403);
  }

  const { pathname } = new URL(request.url);
  const log = /^\/api\/runs\/([^/]+)\/log$/.exec(pathname);
  if (log) {
    if (request.method !== "GET") return text("Method not allowed\n", 405);
    const run = log[1] ?? "";
    if (!RUN_ID.test(run)) return text("Not found\n", 404);
    const body = await env.RUN_STATE.getByName(run).readLog();
    if (!body) return text("No log for this run\n", 404);
    return text(body, 200);
  }
  return text("Not found\n", 404);
}

/**
 * Plain text the browser won't render, sniff, frame or cache. A log holds what the
 * agent printed, so it's treated as untrusted.
 */
function text(body: string, status: number): Response {
  return new Response(body, {
    status,
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "X-Content-Type-Options": "nosniff",
      "Content-Security-Policy": "default-src 'none'; frame-ancestors 'none'",
      "Cache-Control": "no-store",
      "Referrer-Policy": "no-referrer",
    },
  });
}
