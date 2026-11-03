declare namespace Cloudflare {
  interface Env {
    BUILD_ID: string;
    GITHUB_APP_ID: string;
    APPROVER_LOGIN: string;
    /** Comma-separated owner/name list. */
    ALLOWED_REPOS: string;
    GITHUB_APP_PRIVATE_KEY?: string;
    GITHUB_WEBHOOK_SECRET?: string;
    DELIVERY_LOG: DurableObjectNamespace<import("./deliveries").DeliveryLog>;
  }
}

type Env = Cloudflare.Env;
