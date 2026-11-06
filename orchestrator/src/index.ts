import { handleApi } from "./api";
import { handleWebhook } from "./webhook";

export { DeliveryLog } from "./deliveries";
export { RunState } from "./run";
export { Outbound } from "./outbound/handler";

export default {
  async fetch(request, env): Promise<Response> {
    const { pathname } = new URL(request.url);
    if (pathname === "/health" && request.method === "GET") {
      return new Response(env.BUILD_ID);
    }
    if (pathname === "/webhook" && request.method === "POST") {
      return handleWebhook(request, env);
    }
    // The operator's routes, behind Cloudflare Access (ADR-010, #101).
    if (pathname.startsWith("/api/")) {
      return handleApi(request, env);
    }
    return new Response("Not found", { status: 404 });
  },
} satisfies ExportedHandler<Env>;
