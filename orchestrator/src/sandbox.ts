import { registries } from "./outbound/handler";
import { MODEL_HOSTS } from "./outbound/models";
import { redact } from "./redact";

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

/** Every HTTPS request is intercepted, so the platform's CA is the only one a run needs. */
export function caEnv(): Record<string, string> {
  return {
    GIT_SSL_CAINFO: CA_PATH,
    CURL_CA_BUNDLE: CA_PATH,
    SSL_CERT_FILE: CA_PATH,
    NODE_EXTRA_CA_CERTS: CA_PATH,
  };
}

const MAX_OUTPUT = 60_000;

/**
 * Output from the container, made safe to post. It comes from code the orchestrator
 * doesn't trust, so credentials are scrubbed, the length is capped and it can't
 * break out of its code block.
 */
export function scrubOutput(output: string, secrets: string[] = []): string {
  const text = output.length > MAX_OUTPUT ? `${output.slice(0, MAX_OUTPUT)}\n[output cut at ${MAX_OUTPUT} characters]` : output;
  return redact(text, secrets).text.replace(/`{3,}/g, "'''");
}
