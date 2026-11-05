import { deny, type Deny } from "./scope";

export interface ModelHost {
  paths: string[];
  /** The Worker secret holding the key. An unset key fails closed. */
  secret: "ANTHROPIC_API_KEY" | "OPENAI_API_KEY";
  header: "x-api-key" | "authorization";
  /** Headers a client needs that the shared list in handler.ts doesn't carry. */
  headers: string[];
}

/** Adding a vendor is one entry here. */
export const MODEL_HOSTS: Record<string, ModelHost> = {
  "api.anthropic.com": {
    paths: ["/v1/messages", "/v1/messages/count_tokens"],
    secret: "ANTHROPIC_API_KEY",
    header: "x-api-key",
    headers: ["anthropic-version", "anthropic-beta"],
  },
  "api.openai.com": {
    paths: ["/v1/responses"],
    secret: "OPENAI_API_KEY",
    header: "authorization",
    headers: ["openai-beta"],
  },
};

export function parseModels(list: string | undefined): string[] {
  return (list ?? "")
    .split(",")
    .map((model) => model.trim())
    .filter(Boolean);
}

/** Tools the client runs. Anything else, like web search or MCP, runs at the vendor. */
function isClientTool(tool: unknown): boolean {
  const type = (tool as { type?: unknown } | null)?.type;
  if (type === undefined || type === "custom" || type === "function") return true;
  return typeof type === "string" && /^(?:bash|text_editor)_/.test(type);
}

/** An image or file the vendor would fetch, which sends data to any URL. */
function fetchesUrl(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(fetchesUrl);
  if (typeof value !== "object" || value === null) return false;
  const object = value as Record<string, unknown>;
  const source = object.source as { type?: unknown } | undefined;
  if (source?.type === "url") return true;
  for (const key of ["image_url", "file_url"]) {
    const url = object[key];
    const target = typeof url === "object" && url !== null ? (url as { url?: unknown }).url : url;
    if (typeof target === "string" && /^https?:/i.test(target)) return true;
  }
  return Object.values(object).some(fetchesUrl);
}

/**
 * A model call: an allowed endpoint and model, with no way to make the vendor reach
 * another host, which would go around the egress allowlist. Output ceilings, spend and
 * concurrency are in #11.
 */
export function decideModel(
  host: ModelHost,
  method: string,
  pathname: string,
  search: string,
  body: unknown,
  allowedModels: string[],
): { allow: true; body: string } | Deny {
  if (method !== "POST" || !host.paths.includes(pathname)) return deny("model: endpoint not allowed");
  if (search !== "" && search !== "?beta=true") return deny("model: unexpected query");
  if (typeof body !== "object" || body === null || Array.isArray(body)) return deny("model: bad body");

  const request = body as Record<string, unknown>;
  if (typeof request.model !== "string" || !allowedModels.includes(request.model)) {
    return deny("model: model not allowed");
  }
  if (request.mcp_servers !== undefined || request.container !== undefined) {
    return deny("model: vendor-run tools aren't allowed");
  }
  if (request.tools !== undefined) {
    if (!Array.isArray(request.tools) || !request.tools.every(isClientTool)) {
      return deny("model: vendor-run tools aren't allowed");
    }
  }
  if (fetchesUrl(request)) return deny("model: URL inputs aren't allowed");
  return { allow: true, body: JSON.stringify(request) };
}
