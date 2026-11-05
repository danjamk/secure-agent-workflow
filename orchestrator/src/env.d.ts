declare namespace Cloudflare {
  interface Env {
    BUILD_ID: string;
    GITHUB_APP_ID: string;
    APPROVER_LOGIN: string;
    /** Comma-separated owner/name list. */
    ALLOWED_REPOS: string;
    GITHUB_APP_PRIVATE_KEY?: string;
    GITHUB_WEBHOOK_SECRET?: string;
    /** Comma-separated. Empty means no model call is allowed. */
    ALLOWED_MODELS?: string;
    /** JSON: {"owner/name": ["registry.npmjs.org"]}. Empty means no registries. */
    EGRESS_HOSTS?: string;
    ANTHROPIC_API_KEY?: string;
    OPENAI_API_KEY?: string;
    DELIVERY_LOG: DurableObjectNamespace<import("./deliveries").DeliveryLog>;
    RUN_STATE: DurableObjectNamespace<import("./run").RunState>;
  }
}

type Env = Cloudflare.Env;
