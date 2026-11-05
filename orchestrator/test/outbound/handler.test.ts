import { env } from "cloudflare:test";
import { exports } from "cloudflare:workers";
import { afterEach, describe, expect, it, vi } from "vitest";
import { handleOutbound } from "../../src/outbound/handler";
import type { RunScope } from "../../src/outbound/scope";
import { API, begin, BRANCH, command, FLUSH, GIT, join, NEW, PR, REPO, scope, stubInternet, TOKEN, ZERO } from "./helpers";

afterEach(() => {
  vi.restoreAllMocks();
});

const testEnv = (overrides: Partial<Env> = {}): Env => ({ ...env, ...overrides }) as Env;

const SENT_BY_SANDBOX = {
  Authorization: "Bearer stolen",
  Cookie: "session=stolen",
  "Proxy-Authorization": "Basic stolen",
  "X-Forwarded-For": "1.2.3.4",
  "X-HTTP-Method-Override": "DELETE",
  Accept: "application/json",
};

async function startRun(pins: Parameters<typeof begin>[1] = {}): Promise<RunScope> {
  const run = scope();
  await begin(run, pins);
  return run;
}

function pushRequest(body: Uint8Array, headers: HeadersInit = {}): Request {
  return new Request(`${GIT}/git-receive-pack`, { method: "POST", body: body as BodyInit, headers });
}

describe("requests the handler refuses before routing", () => {
  it.each([
    ["an unlisted host", "https://evil.example/"],
    ["a lookalike host", "https://github.com.evil.example/"],
    ["plain HTTP to GitHub", `http://github.com/${REPO}.git/info/refs?service=git-upload-pack`],
    ["plain HTTP to the API", `http://api.github.com/repos/${REPO}`],
    ["another port", `https://api.github.com:8443/repos/${REPO}`],
    ["userinfo in the URL", `https://user:pass@api.github.com/repos/${REPO}`],
    ["a metadata address", "http://169.254.169.254/latest/meta-data/"],
    ["a bare IP", "https://1.1.1.1/"],
    ["an object method as a host", "https://constructor/"],
  ])("blocks %s, and sends nothing", async (_name, url) => {
    const { calls, mints } = stubInternet();
    const response = await handleOutbound(new Request(url), await startRun(), testEnv());
    expect(response.status).toBe(403);
    expect(calls).toHaveLength(0);
    expect(mints()).toBe(0);
  });

  it("denies a run that never began", async () => {
    const { calls } = stubInternet();
    const response = await handleOutbound(new Request(API), scope(), testEnv());
    expect(response.status).toBe(403);
    expect(await response.text()).toContain("isn't active");
    expect(calls).toHaveLength(0);
  });

  it("returns a 503 and no detail when the handler fails", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
      throw new Error(`detail with ${TOKEN}`);
    });
    const run = await startRun();
    const response = await handleOutbound(new Request(API), run, testEnv());
    expect(response.status).toBe(503);
    expect(await response.text()).not.toContain(TOKEN);
  });
});

describe("stop", () => {
  it.each([
    ["GitHub", `${API}/issues/7`],
    ["git", `${GIT}/info/refs?service=git-upload-pack`],
    ["a model", "https://api.anthropic.com/v1/messages"],
    ["a registry", "https://registry.npmjs.org/left-pad"],
  ])("blocks %s once the run is stopped, even an allowed request", async (_name, url) => {
    const { calls } = stubInternet();
    const run = await startRun();
    await env.RUN_STATE.getByName(run.runId).stop();
    const response = await handleOutbound(new Request(url), run, testEnv({ EGRESS_HOSTS: JSON.stringify({ [REPO]: ["registry.npmjs.org"] }) }));
    expect(response.status).toBe(403);
    expect(await response.text()).toContain("stopped");
    expect(calls).toHaveLength(0);
  });

  it("revokes the token on stop, and mints no other", async () => {
    const { mints } = stubInternet();
    const fetched = vi.mocked(fetch);
    const run = await startRun();
    await handleOutbound(new Request(`${API}/issues/7`), run, testEnv());
    expect(mints()).toBe(1);
    await env.RUN_STATE.getByName(run.runId).stop();
    const urls = fetched.mock.calls.map(([input]) => (input instanceof Request ? input.url : String(input)));
    expect(urls.some((url) => url.endsWith("/installation/token"))).toBe(true);
    const refused = await handleOutbound(new Request(`${API}/issues/7`), run, testEnv());
    expect(refused.status).toBe(403);
    expect(mints()).toBe(1);
  });
});

describe("credentials", () => {
  it("adds the token on an API read, and drops what the sandbox sent", async () => {
    const { calls } = stubInternet();
    const request = new Request(`${API}/issues/7?per_page=5#frag`, { headers: SENT_BY_SANDBOX });
    const response = await handleOutbound(request, await startRun(), testEnv());
    expect(response.status).toBe(200);
    const [call] = calls;
    expect(call?.url).toBe(`${API}/issues/7?per_page=5`);
    expect(call?.headers.get("authorization")).toBe(`Bearer ${TOKEN}`);
    expect(call?.headers.get("cookie")).toBeNull();
    expect(call?.headers.get("proxy-authorization")).toBeNull();
    expect(call?.headers.get("x-forwarded-for")).toBeNull();
    expect(call?.headers.get("x-http-method-override")).toBeNull();
    expect(call?.headers.get("accept")).toBe("application/json");
    expect(call?.redirect).toBe("manual");
  });

  it("adds the token as Basic auth on git", async () => {
    const { calls } = stubInternet();
    await handleOutbound(new Request(`${GIT}/info/refs?service=git-upload-pack`, { headers: { "Git-Protocol": "version=2" } }), await startRun(), testEnv());
    expect(calls[0]?.headers.get("authorization")).toBe(`Basic ${btoa(`x-access-token:${TOKEN}`)}`);
    expect(calls[0]?.headers.get("git-protocol")).toBe("version=2");
  });

  it("mints once for several requests, by the repo's id", async () => {
    const { mints } = stubInternet();
    const run = await startRun();
    await handleOutbound(new Request(`${API}/issues/1`), run, testEnv());
    await handleOutbound(new Request(`${API}/issues/2`), run, testEnv());
    expect(mints()).toBe(1);
    const mint = vi.mocked(fetch).mock.calls.find(([input]) => String(input).endsWith("/access_tokens"));
    expect(JSON.parse(String(mint?.[1]?.body))).toEqual({ repository_ids: [run.repoId] });
  });

  it("replaces a token that's close to expiring", async () => {
    const { mints } = stubInternet(undefined, { expiresInMs: 5 * 60 * 1000 });
    const run = await startRun();
    await handleOutbound(new Request(`${API}/issues/1`), run, testEnv());
    await handleOutbound(new Request(`${API}/issues/2`), run, testEnv());
    expect(mints()).toBe(2);
  });

  it.each([
    ["more than the one repo", [{ id: 1234 }, { id: 5678 }]],
    ["another repo", [{ id: 5678 }]],
    ["no repos listed", []],
  ])("revokes and refuses a token for %s", async (_name, repositories) => {
    const { calls, revocations } = stubInternet(undefined, { repositories });
    const response = await handleOutbound(new Request(`${API}/issues/1`), await startRun(), testEnv());
    expect(response.status).toBe(503);
    expect(calls).toHaveLength(0);
    expect(revocations()).toBe(1);
  });

  it.each([
    [301, `https://evil.example/${TOKEN}`],
    [302, "https://codeload.github.com/signed?token=abc"],
    [307, "https://evil.example/"],
    [308, "https://evil.example/"],
  ])("refuses a %i from GitHub, and doesn't return its Location", async (status, location) => {
    const { calls } = stubInternet(() => new Response(null, { status, headers: { Location: location } }));
    const response = await handleOutbound(new Request(`${API}/tarball`), await startRun(), testEnv());
    expect(response.status).toBe(502);
    expect(response.headers.get("location")).toBeNull();
    expect(calls).toHaveLength(1);
  });

  it("logs a failure from upstream, with no path or body", async () => {
    const logged: string[] = [];
    vi.spyOn(console, "warn").mockImplementation((...args) => {
      logged.push(args.join(" "));
    });
    stubInternet(() => new Response("error code: 502", { status: 502 }));
    const run = await startRun();
    const response = await handleOutbound(new Request(`${API}/issues/7?secret=x`), run, testEnv());
    expect(response.status).toBe(502);
    const line = JSON.parse(logged.find((entry) => entry.includes("upstream")) ?? "{}") as Record<string, unknown>;
    expect(line).toMatchObject({ run: run.runId, upstream: "api.github.com", method: "GET", status: 502 });
    expect(logged.join(" ")).not.toContain("issues");
    expect(logged.join(" ")).not.toContain(TOKEN);
  });

  it("judges a DELETE with no body by its route", async () => {
    const { calls } = stubInternet();
    const request = new Request(`${API}/issues/7/labels/agent:stop`, { method: "DELETE" });
    const response = await handleOutbound(request, await startRun(), testEnv());
    expect(response.status).toBe(403);
    expect(await response.text()).toContain("call not allowed");
    expect(calls).toHaveLength(0);
  });

  it("passes a 304 through", async () => {
    stubInternet(() => new Response(null, { status: 304 }));
    const response = await handleOutbound(new Request(`${API}/issues/7`), await startRun(), testEnv());
    expect(response.status).toBe(304);
  });

  it("drops cookies from responses", async () => {
    stubInternet(() => new Response("ok", { headers: { "Set-Cookie": "a=b" } }));
    const response = await handleOutbound(new Request(`${API}/issues/7`), await startRun(), testEnv());
    expect(response.headers.get("set-cookie")).toBeNull();
  });

  it("never puts the token in anything returned to the sandbox", async () => {
    stubInternet();
    const response = await handleOutbound(new Request(`${API}/issues/7`), await startRun(), testEnv());
    const everything = `${await response.text()} ${JSON.stringify([...response.headers])}`;
    expect(everything).not.toContain(TOKEN);
  });

  it("keeps the token out of the run's scope", async () => {
    stubInternet();
    const run = await startRun();
    await handleOutbound(new Request(`${API}/issues/7`), run, testEnv());
    expect(JSON.stringify(run)).not.toContain(TOKEN);
  });
});

describe("git push through the handler", () => {
  it("forwards a push byte for byte, and pins the branch", async () => {
    const { calls } = stubInternet();
    const run = await startRun();
    const pack = new TextEncoder().encode("PACK\0binary\xff".repeat(100));
    const body = join(command(BRANCH, NEW, ZERO), FLUSH, pack);
    const response = await handleOutbound(pushRequest(body), run, testEnv());
    expect(response.status).toBe(200);
    expect(calls[0]?.body).toEqual(body);
    expect((await env.RUN_STATE.getByName(run.runId).admit())).toMatchObject({ branch: BRANCH });
  });

  it("reads commands split across chunks", async () => {
    const { calls } = stubInternet();
    const body = join(command(BRANCH), FLUSH, new TextEncoder().encode("PACK"));
    const stream = new ReadableStream({
      start(controller) {
        for (const byte of body) controller.enqueue(new Uint8Array([byte]));
        controller.close();
      },
    });
    const request = new Request(`${GIT}/git-receive-pack`, { method: "POST", body: stream });
    const response = await handleOutbound(request, await startRun(), testEnv());
    expect(response.status).toBe(200);
    expect(calls[0]?.body).toEqual(body);
  });

  it("forwards git's empty probe, and pins nothing", async () => {
    const { calls } = stubInternet();
    const run = await startRun();
    const response = await handleOutbound(pushRequest(join(FLUSH)), run, testEnv());
    expect(response.status).toBe(200);
    expect(calls[0]?.body).toEqual(FLUSH);
    expect(await env.RUN_STATE.getByName(run.runId).admit()).toMatchObject({ branch: null });
  });

  it.each([
    ["to main", () => join(command("refs/heads/main"), FLUSH)],
    ["deleting a branch", () => join(command(BRANCH, ZERO), FLUSH)],
    ["with a pack after an empty command list", () => join(FLUSH, new TextEncoder().encode("PACK"))],
    ["with a bad length", () => new TextEncoder().encode("zzzz0000")],
    ["with no flush", () => join(command(BRANCH))],
  ])("sends nothing for a push %s", async (_name, body) => {
    const { calls } = stubInternet();
    const response = await handleOutbound(pushRequest(body()), await startRun(), testEnv());
    expect(response.status).toBe(403);
    expect(calls).toHaveLength(0);
  });

  it("denies an encoded push, which would hide its commands", async () => {
    const { calls } = stubInternet();
    const body = join(command(BRANCH), FLUSH);
    const response = await handleOutbound(pushRequest(body, { "Content-Encoding": "gzip" }), await startRun(), testEnv());
    expect(response.status).toBe(403);
    expect(calls).toHaveLength(0);
  });

  it("denies commands larger than the limit", async () => {
    const { calls } = stubInternet();
    const huge = join(...Array.from({ length: 2000 }, () => command(BRANCH)));
    const response = await handleOutbound(pushRequest(huge), await startRun(), testEnv());
    expect(response.status).toBe(403);
    expect(calls).toHaveLength(0);
  });

  it("keeps the first branch when a second is pushed", async () => {
    const { calls } = stubInternet();
    const run = await startRun();
    await handleOutbound(pushRequest(join(command(BRANCH), FLUSH)), run, testEnv());
    const other = await handleOutbound(pushRequest(join(command("refs/heads/agent/7-other"), FLUSH)), run, testEnv());
    expect(other.status).toBe(403);
    expect(calls).toHaveLength(1);
  });
});

describe("the PR pin", () => {
  const created = () => Response.json({ number: PR.number, node_id: PR.nodeId }, { status: 201 });
  const pull = { title: "Add parser", head: "agent/7-add-parser", base: "main", body: "Closes #7" };
  const post = (url: string, body: unknown, headers: HeadersInit = {}) =>
    new Request(url, { method: "POST", body: JSON.stringify(body), headers });

  it("pins the PR from GitHub's response, and then allows writes to it", async () => {
    const { calls } = stubInternet(created);
    const run = await startRun({ branch: BRANCH });
    const response = await handleOutbound(post(`${API}/pulls`, pull), run, testEnv());
    expect(response.status).toBe(201);
    expect(await response.json()).toMatchObject({ number: PR.number });
    expect(await env.RUN_STATE.getByName(run.runId).admit()).toMatchObject({ pr: PR });

    const ready = await handleOutbound(
      post("https://api.github.com/graphql", {
        query: `mutation { markPullRequestReadyForReview(input: { pullRequestId: "${PR.nodeId}" }) { clientMutationId } }`,
      }),
      run,
      testEnv(),
    );
    expect(ready.status).toBe(201);
    expect(calls).toHaveLength(2);
  });

  it("doesn't pin a PR that GitHub refused", async () => {
    stubInternet(() => new Response("{}", { status: 422 }));
    const run = await startRun({ branch: BRANCH });
    const response = await handleOutbound(post(`${API}/pulls`, pull), run, testEnv());
    expect(response.status).toBe(422);
    expect(await env.RUN_STATE.getByName(run.runId).admit()).toMatchObject({ pr: null });
  });

  it("forwards the fields it checked, not the raw request", async () => {
    const { calls } = stubInternet(() => new Response("{}", { status: 201 }));
    const run = await startRun();
    const raw = `{"body":"First","body":"Second"}`;
    await handleOutbound(new Request(`${API}/issues/7/comments`, { method: "POST", body: raw }), run, testEnv());
    expect(new TextDecoder().decode(calls[0]?.body)).toBe('{"body":"Second"}');
  });

  it.each([
    ["a query on a write", `${API}/issues/7/comments?_method=DELETE`, { body: "x" }],
    ["a query on GraphQL", "https://api.github.com/graphql?query=x", {}],
  ])("denies %s", async (_name, url, body) => {
    const { calls } = stubInternet();
    const response = await handleOutbound(post(url, body), await startRun({ branch: BRANCH }), testEnv());
    expect(response.status).toBe(403);
    expect(calls).toHaveLength(0);
  });

  it("denies a GraphQL GET, and forces JSON on what it rebuilt", async () => {
    const { calls } = stubInternet();
    const run = await startRun();
    const get = new Request("https://api.github.com/graphql?query=%7Bviewer%7Bid%7D%7D");
    expect((await handleOutbound(get, run, testEnv())).status).toBe(403);
    expect(calls).toHaveLength(0);
    await handleOutbound(post(`${API}/issues/7/comments`, { body: "x" }, { "Content-Type": "text/plain" }), run, testEnv());
    expect(calls[0]?.headers.get("content-type")).toBe("application/json");
    expect(calls[0]?.headers.get("user-agent")).toBe("secure-agent-workflow");
  });

  it("denies a body that isn't JSON or is too large", async () => {
    const { calls } = stubInternet();
    const run = await startRun();
    const notJson = new Request(`${API}/issues/7/comments`, { method: "POST", body: "not json" });
    expect((await handleOutbound(notJson, run, testEnv())).status).toBe(403);
    const large = new Request(`${API}/issues/7/comments`, { method: "POST", body: "x".repeat(1024 * 1024 + 1) });
    expect((await handleOutbound(large, run, testEnv())).status).toBe(403);
    expect(calls).toHaveLength(0);
  });
});

describe("model hosts", () => {
  const request = (headers: HeadersInit = {}) =>
    new Request("https://api.anthropic.com/v1/messages", {
      method: "POST",
      body: JSON.stringify({ model: "allowed-model", max_tokens: 1 }),
      headers: { "anthropic-version": "2023-06-01", ...headers },
    });
  const configured = testEnv({ ALLOWED_MODELS: "allowed-model", ANTHROPIC_API_KEY: "model-key", OPENAI_API_KEY: "openai-key" });

  it("adds the key, and drops the one the sandbox sent", async () => {
    const { calls } = stubInternet();
    const response = await handleOutbound(request({ "x-api-key": "placeholder" }), await startRun(), configured);
    expect(response.status).toBe(200);
    expect(calls[0]?.headers.get("x-api-key")).toBe("model-key");
    expect(calls[0]?.headers.get("anthropic-version")).toBe("2023-06-01");
  });

  it("sends OpenAI's key as a bearer token", async () => {
    const { calls } = stubInternet();
    const call = new Request("https://api.openai.com/v1/responses", {
      method: "POST",
      body: JSON.stringify({ model: "allowed-model" }),
    });
    await handleOutbound(call, await startRun(), configured);
    expect(calls[0]?.headers.get("authorization")).toBe("Bearer openai-key");
  });

  it("fails closed when the key isn't set", async () => {
    const { calls } = stubInternet();
    const response = await handleOutbound(request(), await startRun(), testEnv({ ALLOWED_MODELS: "allowed-model" }));
    expect(response.status).toBe(503);
    expect(calls).toHaveLength(0);
  });

  it("allows no model by default", async () => {
    const { calls } = stubInternet();
    const response = await handleOutbound(request(), await startRun(), testEnv({ ANTHROPIC_API_KEY: "model-key" }));
    expect(response.status).toBe(403);
    expect(calls).toHaveLength(0);
  });

  it("doesn't return a redirect from a call that carried a key", async () => {
    stubInternet(() => new Response(null, { status: 302, headers: { Location: "https://evil.example/" } }));
    const response = await handleOutbound(request(), await startRun(), configured);
    expect(response.status).toBe(502);
  });
});

describe("package registries", () => {
  const withHosts = (hosts: unknown) => testEnv({ EGRESS_HOSTS: JSON.stringify({ [REPO]: hosts }) });

  it("allows a read with no credentials", async () => {
    const { calls, mints } = stubInternet();
    const request = new Request("https://registry.npmjs.org/left-pad", { headers: SENT_BY_SANDBOX });
    const response = await handleOutbound(request, await startRun(), withHosts(["registry.npmjs.org"]));
    expect(response.status).toBe(200);
    expect(calls[0]?.headers.get("authorization")).toBeNull();
    expect(calls[0]?.headers.get("cookie")).toBeNull();
    expect(mints()).toBe(0);
  });

  it("denies a write, such as npm publish", async () => {
    const { calls } = stubInternet();
    const request = new Request("https://registry.npmjs.org/left-pad", { method: "PUT", body: "{}" });
    const response = await handleOutbound(request, await startRun(), withHosts(["registry.npmjs.org"]));
    expect(response.status).toBe(403);
    expect(calls).toHaveLength(0);
  });

  it("denies a host listed for another repo", async () => {
    const { calls } = stubInternet();
    const others = testEnv({ EGRESS_HOSTS: JSON.stringify({ "the-approver/other": ["registry.npmjs.org"] }) });
    const response = await handleOutbound(new Request("https://registry.npmjs.org/x"), await startRun(), others);
    expect(response.status).toBe(403);
    expect(calls).toHaveLength(0);
  });

  it.each([
    ["no setting", undefined],
    ["bad JSON", "{not json"],
    ["a list that isn't a list", JSON.stringify({ [REPO]: "registry.npmjs.org" })],
  ])("denies with %s", async (_name, value) => {
    const { calls } = stubInternet();
    const response = await handleOutbound(new Request("https://registry.npmjs.org/x"), await startRun(), testEnv({ EGRESS_HOSTS: value }));
    expect(response.status).toBe(403);
    expect(calls).toHaveLength(0);
  });

  it("passes a registry's redirect back, because it carried no credential", async () => {
    stubInternet(() => new Response(null, { status: 302, headers: { Location: "https://mirror.example/x" } }));
    const response = await handleOutbound(new Request("https://registry.opentofu.org/x"), await startRun(), withHosts(["registry.opentofu.org"]));
    expect(response.status).toBe(302);
  });

  it("allows release downloads on github.com only if listed, with no token", async () => {
    const release = "https://github.com/hashicorp/thing/releases/download/v1.0.0/thing.zip";
    const { calls, mints } = stubInternet();
    expect((await handleOutbound(new Request(release), await startRun(), testEnv())).status).toBe(403);
    const response = await handleOutbound(new Request(release), await startRun(), withHosts(["github.com"]));
    expect(response.status).toBe(200);
    expect(calls[0]?.headers.get("authorization")).toBeNull();
    expect(mints()).toBe(0);
  });

  it("matches a listed host exactly", async () => {
    const { calls } = stubInternet();
    const run = await startRun();
    const lists = withHosts(["registry.npmjs.org.evil.example", "evil-github.com", "NPMJS.ORG"]);
    for (const url of [
      "https://registry.npmjs.org/x",
      "https://evil.example/registry.npmjs.org",
      "https://npmjs.org/x",
      "https://github.com/a/b/releases/download/v1/c.zip",
    ]) {
      expect((await handleOutbound(new Request(url), run, lists)).status).toBe(403);
    }
    expect(calls).toHaveLength(0);
  });

  it("listing github.com opens release downloads and nothing else", async () => {
    const { calls } = stubInternet();
    const run = await startRun();
    const response = await handleOutbound(new Request("https://github.com/someone/other.git/info/refs?service=git-upload-pack"), run, withHosts(["github.com"]));
    expect(response.status).toBe(403);
    expect(calls).toHaveLength(0);
  });
});

describe("the entrypoint", () => {
  it("applies the policy with the props it was given", async () => {
    const { calls } = stubInternet();
    const run = await startRun();
    const outbound = (exports as unknown as { Outbound: (options: { props: RunScope }) => Fetcher }).Outbound({ props: run });
    expect((await outbound.fetch(`${API}/issues/7`)).status).toBe(200);
    expect((await outbound.fetch("https://evil.example/")).status).toBe(403);
    expect(calls).toHaveLength(1);
  });
});
