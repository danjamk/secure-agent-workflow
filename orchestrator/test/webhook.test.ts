// The test:security suite: who can release an issue, through the whole Worker.
// Only GitHub is stubbed; the Durable Object is real.
import { afterEach, describe, expect, it, vi } from "vitest";
import { handleWebhook } from "../src/webhook";
import { deliver, release, sign, stubGitHub, testEnv } from "./helpers";

afterEach(() => vi.restoreAllMocks());

describe("signature", () => {
  it.each([
    ["missing", null],
    ["malformed", "sha256=nothex"],
    ["sha1 form", "sha1=0000000000000000000000000000000000000000"],
    ["all zeros", `sha256=${"0".repeat(64)}`],
  ])("rejects a %s signature", async (_name, signature) => {
    const calls = stubGitHub();
    const response = await deliver(release(), { signature });
    expect(response.status).toBe(401);
    expect(calls).toEqual([]);
  });

  it("rejects a signature made with another secret", async () => {
    const calls = stubGitHub();
    const body = JSON.stringify(release());
    const response = await deliver(body, { signature: await sign(body, "another-secret") });
    expect(response.status).toBe(401);
    expect(calls).toEqual([]);
  });

  it("rejects a body changed after signing", async () => {
    const calls = stubGitHub();
    const signature = await sign(JSON.stringify(release()));
    const changed = JSON.stringify(release({ issue: { number: 8, state: "open" } }));
    const response = await deliver(changed, { signature });
    expect(response.status).toBe(401);
    expect(calls).toEqual([]);
  });

  it("refuses everything when the secret isn't set", async () => {
    const calls = stubGitHub();
    const body = JSON.stringify(release());
    const request = new Request("https://orchestrator.test/webhook", {
      method: "POST",
      headers: { "X-GitHub-Event": "issues", "X-Hub-Signature-256": await sign(body) },
      body,
    });
    const env = { ...testEnv(), GITHUB_WEBHOOK_SECRET: undefined };
    const response = await handleWebhook(request, env);
    expect(response.status).toBe(500);
    expect(calls).toEqual([]);
  });

  it("rejects a signed body that isn't JSON", async () => {
    const calls = stubGitHub();
    const response = await deliver("not json");
    expect(response.status).toBe(400);
    expect(calls).toEqual([]);
  });
});

describe("what counts as a release", () => {
  it.each<[string, Record<string, unknown>]>([
    ["unlabeled action", { action: "unlabeled" }],
    ["another label", { label: { name: "agent:stop" } }],
    ["another sender", { sender: { login: "someone-else", type: "User" } }],
    ["the agent App", { sender: { login: "danjamk-build-agent[bot]", type: "Bot" } }],
    ["a bot with the approver's login", { sender: { login: "the-approver", type: "Bot" } }],
    ["no sender", { sender: undefined }],
    ["a repo not on the list", { repository: { full_name: "the-approver/secret" } }],
    ["a closed issue", { issue: { number: 7, state: "closed" } }],
    ["no installation", { installation: undefined }],
  ])("ignores %s", async (_name, overrides) => {
    const calls = stubGitHub();
    const response = await deliver(release(overrides));
    expect(response.status).toBe(200);
    expect(await response.json()).toHaveProperty("ignored");
    expect(calls).toEqual([]);
  });

  it("ignores other events, including the bot's own comment", async () => {
    const calls = stubGitHub();
    const response = await deliver(release(), { event: "issue_comment" });
    expect(response.status).toBe(200);
    expect(calls).toEqual([]);
  });

  it("ignores everyone when the approver or the repo list is empty", async () => {
    for (const change of [{ APPROVER_LOGIN: "" }, { ALLOWED_REPOS: "" }]) {
      const calls = stubGitHub();
      const body = JSON.stringify(release());
      const request = new Request("https://orchestrator.test/webhook", {
        method: "POST",
        headers: { "X-GitHub-Event": "issues", "X-Hub-Signature-256": await sign(body) },
        body,
      });
      const response = await handleWebhook(request, { ...testEnv(), ...change });
      expect(await response.json()).toHaveProperty("ignored");
      expect(calls).toEqual([]);
    }
  });

  it("compares the login and repo without case", async () => {
    const calls = stubGitHub();
    const response = await deliver(
      release({
        sender: { login: "The-Approver", type: "User" },
        repository: { full_name: "The-Approver/App" },
      }),
    );
    expect(response.status).toBe(202);
    expect(calls.length).toBeGreaterThan(0);
  });
});

describe("a release", () => {
  it("mints a token for the one repo, comments with it, and revokes it", async () => {
    const calls = stubGitHub();
    const response = await deliver(release());
    expect(response.status).toBe(202);
    expect(calls.map((c) => `${c.method} ${new URL(c.url).pathname}`)).toEqual([
      "POST /app/installations/99/access_tokens",
      "POST /repos/the-approver/app/issues/7/comments",
      "DELETE /installation/token",
    ]);
    expect(calls[0]?.body).toEqual({ repositories: ["app"] });
    expect(calls[1]?.authorization).toBe("Bearer minted-token");
    expect(calls[2]?.authorization).toBe("Bearer minted-token");
  });

  it("handles one delivery id once", async () => {
    const calls = stubGitHub();
    const delivery = crypto.randomUUID();
    expect((await deliver(release(), { delivery })).status).toBe(202);
    const second = await deliver(release(), { delivery });
    expect(second.status).toBe(200);
    expect(await second.json()).toEqual({ ignored: "duplicate delivery" });
    expect(calls.filter((c) => c.url.endsWith("/access_tokens"))).toHaveLength(1);
  });

  it("lets a redelivery retry after a failure", async () => {
    const delivery = crypto.randomUUID();
    stubGitHub(() => new Response("nope", { status: 500 }));
    expect((await deliver(release(), { delivery })).status).toBe(502);
    vi.restoreAllMocks();
    stubGitHub();
    expect((await deliver(release(), { delivery })).status).toBe(202);
  });

  it("revokes and stops when the token isn't limited to the one repo", async () => {
    const calls = stubGitHub(() =>
      Response.json(
        {
          token: "too-wide",
          repositories: [{ full_name: "the-approver/app" }, { full_name: "the-approver/other" }],
        },
        { status: 201 },
      ),
    );
    const response = await deliver(release());
    expect(response.status).toBe(502);
    expect(calls.map((c) => c.method)).toEqual(["POST", "DELETE"]);
    expect(calls[1]?.authorization).toBe("Bearer too-wide");
  });

  it("refuses a token response with no repo list", async () => {
    const calls = stubGitHub(() => Response.json({ token: "unknown" }, { status: 201 }));
    expect((await deliver(release())).status).toBe(502);
    expect(calls.filter((c) => c.url.endsWith("/comments"))).toEqual([]);
  });

  it("never puts a credential in a response or a log", async () => {
    const logged: string[] = [];
    for (const method of ["log", "error"] as const) {
      vi.spyOn(console, method).mockImplementation((...args) => {
        logged.push(args.join(" "));
      });
    }
    stubGitHub(() =>
      Response.json({ token: "minted-token", repositories: [] }, { status: 201 }),
    );
    const response = await deliver(release());
    const text = `${await response.text()} ${logged.join(" ")}`;
    expect(text).not.toContain("minted-token");
    expect(text).not.toContain("PRIVATE KEY");
  });
});
