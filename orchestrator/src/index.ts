import { handleApi } from "./api";
import { reconcile } from "./reconcile";
import { handleWebhook } from "./webhook";

export { DeliveryLog } from "./deliveries";
export { RunState } from "./run";
export { Outbound } from "./outbound/handler";

export default {
  async fetch(request, env, ctx): Promise<Response> {
    const { pathname } = new URL(request.url);
    if (pathname === "/health" && request.method === "GET") {
      return new Response(env.BUILD_ID);
    }
    if (pathname === "/webhook" && request.method === "POST") {
      return handleWebhook(request, env, ctx);
    }
    // The operator's routes, behind Cloudflare Access (ADR-010, #101).
    if (pathname.startsWith("/api/")) {
      return handleApi(request, env);
    }
    return new Response("Not found", { status: 404 });
  },

  // Every 5 minutes: catch up on webhooks GitHub didn't deliver (#110).
  async scheduled(_controller, env, ctx): Promise<void> {
    ctx.waitUntil(
      reconcile(env).catch((error: unknown) => {
        console.error(`Reconciling failed: ${(error as Error).name}`);
      }),
    );
  },
} satisfies ExportedHandler<Env>;
