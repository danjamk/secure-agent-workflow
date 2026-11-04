import { handleWebhook } from "./webhook";

export { DeliveryLog } from "./deliveries";

export default {
  async fetch(request, env): Promise<Response> {
    const { pathname } = new URL(request.url);
    if (pathname === "/health" && request.method === "GET") {
      return new Response(env.BUILD_ID);
    }
    if (pathname === "/webhook" && request.method === "POST") {
      return handleWebhook(request, env);
    }
    return new Response("Not found", { status: 404 });
  },
} satisfies ExportedHandler<Env>;
