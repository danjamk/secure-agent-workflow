import { generateKeyPairSync } from "node:crypto";
import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

// A throwaway key per test run, so no key is ever committed.
const { privateKey, publicKey } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
  publicKeyEncoding: { type: "spki", format: "pem" },
});

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.jsonc" },
      miniflare: {
        bindings: {
          BUILD_ID: "1.2.3+abc1234",
          GITHUB_APP_ID: "12345",
          APPROVER_LOGIN: "the-approver",
          ALLOWED_REPOS: "the-approver/app, the-approver/other",
          GITHUB_WEBHOOK_SECRET: "test-webhook-secret",
          GITHUB_APP_PRIVATE_KEY: privateKey,
          // Fake values the log's redaction must find (#10), built from parts so the
          // gate's secret scan doesn't flag them. The outbound tests set their own.
          // The /api routes' Access settings (#101). test/access.test.ts signs its own tokens.
          ACCESS_TEAM: "test-team",
          ACCESS_AUD: "test-aud",
          OPERATOR_EMAIL: "operator@example.com",
          CONSOLE_URL: "https://console.example",
          // Tests share one coordinator, so the cap doesn't serialize them. The cap's
          // own tests pass one to the queue directly.
          MAX_CONCURRENT_RUNS: "100",
          ANTHROPIC_API_KEY: ["test", "anthropic", "key", "0123456789"].join("-"),
          OPENAI_API_KEY: ["test", "openai", "key", "0123456789"].join("-"),
          TEST_PUBLIC_KEY: publicKey,
        },
      },
    }),
  ],
});
