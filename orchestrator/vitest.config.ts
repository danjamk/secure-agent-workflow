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
          TEST_PUBLIC_KEY: publicKey,
        },
      },
    }),
  ],
});
