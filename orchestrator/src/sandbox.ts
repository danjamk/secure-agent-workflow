import { registries } from "./outbound/handler";
import { MODEL_HOSTS } from "./outbound/models";
import type { RunScope } from "./outbound/scope";

/** The certificate the platform signs intercepted HTTPS with. It appears once HTTPS is intercepted. */
export const CA_PATH = "/etc/cloudflare/certs/cloudflare-containers-ca.crt";

/** The platform allows 128 intercepts per container. */
const MAX_HOSTS = 128;

/**
 * The hosts a run's container can reach, all through the Outbound entrypoint. Each
 * is listed by name instead of `*`, so other names don't resolve and DNS can't carry
 * data out. There's no plain HTTP intercept: the policy refuses HTTP anyway.
 */
export function interceptHosts(env: Env, repo: string): string[] {
  const hosts = [...new Set(["github.com", "api.github.com", ...Object.keys(MODEL_HOSTS), ...registries(env, repo)])];
  if (hosts.length > MAX_HOSTS) throw new Error(`More than ${MAX_HOSTS} hosts for one run`);
  return hosts;
}

/** What the probe gets. Nothing secret: the container holds no credentials. */
export function probeEnv(scope: RunScope, slug: string): Record<string, string> {
  return {
    REPO: scope.repo,
    ISSUE: String(scope.issue),
    SLUG: slug,
    DEFAULT_BRANCH: scope.defaultBranch,
    HOME: "/root",
    // Every HTTPS request is intercepted, so the platform's CA is the only one needed.
    GIT_SSL_CAINFO: CA_PATH,
    CURL_CA_BUNDLE: CA_PATH,
    SSL_CERT_FILE: CA_PATH,
    NODE_EXTRA_CA_CERTS: CA_PATH,
  };
}

/** A branch name the probe can use: agent/<issue>-probe-<8 hex>. */
export function probeSlug(runId: string): string {
  return `probe-${runId.replace(/[^0-9a-f]/gi, "").slice(0, 8).toLowerCase()}`;
}

const MAX_OUTPUT = 60_000;
const CREDENTIALS =
  /gh[opsu]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|sk-ant-[A-Za-z0-9_-]{10,}|sk-[A-Za-z0-9_-]{20,}|x-access-token:[^\s@]+|-----BEGIN[^-]*PRIVATE KEY-----[\s\S]*?(?:-----END[^-]*PRIVATE KEY-----|$)/g;

/**
 * Output from the container, made safe to post. It comes from code the orchestrator
 * doesn't trust, so credentials are scrubbed, the length is capped and it can't
 * break out of its code block.
 */
export function scrubOutput(output: string, secrets: string[] = []): string {
  let text = output.length > MAX_OUTPUT ? `${output.slice(0, MAX_OUTPUT)}\n[output cut at ${MAX_OUTPUT} characters]` : output;
  for (const secret of secrets.filter((value) => value.length >= 8)) {
    text = text.split(secret).join("[removed]");
  }
  return text.replace(CREDENTIALS, "[removed]").replace(/`{3,}/g, "'''");
}
