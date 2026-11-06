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
    /** JSON: {"model": {input, output, cacheWrite5m, cacheWrite1h, cacheRead}}, dollars per million tokens. An unpriced model is refused. */
    MODEL_PRICES?: string;
    /** Dollars. Unset or invalid is 0, which refuses every charged model call. */
    RUN_BUDGET_USD?: string;
    ISSUE_BUDGET_USD?: string;
    MONTHLY_BUDGET_USD?: string;
    /** The largest max_tokens a model call may ask for. */
    MAX_OUTPUT_TOKENS?: string;
    /** JSON: {"owner/name": ["registry.npmjs.org"]}. Empty means no registries. */
    EGRESS_HOSTS?: string;
    /** The Access team name, as in <team>.cloudflareaccess.com. Empty refuses every /api request. */
    ACCESS_TEAM?: string;
    /** The console's Access application AUD tag. */
    ACCESS_AUD?: string;
    /** The only identity the /api routes accept. */
    OPERATOR_EMAIL?: string;
    /** The console's URL, for each run's log link (#105). Empty posts no link. */
    CONSOLE_URL?: string;
    ANTHROPIC_API_KEY?: string;
    OPENAI_API_KEY?: string;
    DELIVERY_LOG: DurableObjectNamespace<import("./deliveries").DeliveryLog>;
    RUN_STATE: DurableObjectNamespace<import("./run").RunState>;
  }
}

type Env = Cloudflare.Env;
