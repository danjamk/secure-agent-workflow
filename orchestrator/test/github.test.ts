import { afterEach, expect, it, vi } from "vitest";
import { appJwt, mintInstallationToken } from "../src/github";
import { stubGitHub, testEnv } from "./helpers";

afterEach(() => vi.restoreAllMocks());

function decode(part: string | undefined): Record<string, unknown> {
  const padded = (part ?? "").replaceAll("-", "+").replaceAll("_", "/");
  return JSON.parse(atob(padded));
}

it("signs an App JWT the public key verifies", async () => {
  const env = testEnv();
  const now = 1_800_000_000_000;
  const jwt = await appJwt(env.GITHUB_APP_ID, env.GITHUB_APP_PRIVATE_KEY ?? "", now);
  const [header, claims, signature] = jwt.split(".");

  expect(decode(header)).toEqual({ alg: "RS256", typ: "JWT" });
  expect(decode(claims)).toEqual({ iat: 1_799_999_940, exp: 1_800_000_540, iss: "12345" });

  const der = Uint8Array.from(
    atob(env.TEST_PUBLIC_KEY.replace(/-----[^-]+-----|\s/g, "")),
    (c) => c.charCodeAt(0),
  );
  const key = await crypto.subtle.importKey(
    "spki",
    der,
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["verify"],
  );
  const bytes = Uint8Array.from(
    atob((signature ?? "").replaceAll("-", "+").replaceAll("_", "/")),
    (c) => c.charCodeAt(0),
  );
  const valid = await crypto.subtle.verify(
    "RSASSA-PKCS1-v1_5",
    key,
    bytes,
    new TextEncoder().encode(`${header}.${claims}`),
  );
  expect(valid).toBe(true);
});

it("names the format when given GitHub's PKCS#1 key, without echoing it", async () => {
  const pem = "-----BEGIN RSA PRIVATE KEY-----\nc2VjcmV0\n-----END RSA PRIVATE KEY-----";
  await expect(appJwt("1", pem)).rejects.toThrow("not a PKCS#8 PEM");
  await expect(appJwt("1", pem)).rejects.not.toThrow("c2VjcmV0");
});

it("sends the App JWT to mint, not a token", async () => {
  const calls = stubGitHub();
  const token = await mintInstallationToken(testEnv(), 99, "the-approver/app");
  expect(token).toBe("minted-token");
  expect(calls[0]?.authorization?.split(".")).toHaveLength(3);
});

it("refuses to mint when the App id or key isn't set", async () => {
  const calls = stubGitHub();
  for (const change of [{ GITHUB_APP_ID: "" }, { GITHUB_APP_PRIVATE_KEY: undefined }]) {
    await expect(
      mintInstallationToken({ ...testEnv(), ...change }, 99, "the-approver/app"),
    ).rejects.toThrow("is not set");
  }
  expect(calls).toEqual([]);
});
