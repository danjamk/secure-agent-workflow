// The console Worker forwards /api/* and adds nothing of its own (#105, ADR-010).
import { describe, expect, it } from "vitest";
import worker, { type Env } from "../src/worker";

function setup() {
  const forwarded: Request[] = [];
  const env = {
    BUILD_ID: "1.2.3+abc",
    ORCHESTRATOR: {
      fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
        forwarded.push(new Request(input, init));
        return new Response("from the orchestrator", { status: 403 });
      },
    },
    ASSETS: { fetch: async () => new Response("asset") },
  } as unknown as Env;
  const call = (path: string, init: RequestInit = {}) =>
    worker.fetch(new Request(`https://console.example${path}`, init) as Parameters<typeof worker.fetch>[0], env);
  return { forwarded, call };
}

describe("the console Worker", () => {
  it("forwards /api/* with Access's token, and returns the orchestrator's answer as it is", async () => {
    const { forwarded, call } = setup();
    const response = await call("/api/runs/abc/log?x=1", { headers: { "Cf-Access-Jwt-Assertion": "header-token" } });
    expect(response.status).toBe(403);
    expect(await response.text()).toBe("from the orchestrator");
    expect(forwarded).toHaveLength(1);
    const [request] = forwarded;
    expect(new URL(request!.url).pathname + new URL(request!.url).search).toBe("/api/runs/abc/log?x=1");
    expect(request!.headers.get("Cf-Access-Jwt-Assertion")).toBe("header-token");
  });

  it("drops cookies, and uses Access's cookie only when the header is missing", async () => {
    const { forwarded, call } = setup();
    const cookies = "other=1; CF_Authorization=cookie-token; more=2";
    await call("/api/x", { headers: { Cookie: cookies } });
    await call("/api/x", { headers: { Cookie: cookies, "Cf-Access-Jwt-Assertion": "header-token" } });
    expect(forwarded.map((r) => r.headers.get("Cookie"))).toEqual([null, null]);
    expect(forwarded.map((r) => r.headers.get("Cf-Access-Jwt-Assertion"))).toEqual(["cookie-token", "header-token"]);
  });

  it("sends no token of its own when the browser has none", async () => {
    const { forwarded, call } = setup();
    await call("/api/x");
    expect(forwarded[0]?.headers.get("Cf-Access-Jwt-Assertion")).toBeNull();
  });

  it("forwards a write's method, Origin and body", async () => {
    const { forwarded, call } = setup();
    await call("/api/runs/app/7/stop", {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: "https://console.example" },
      body: "{}",
    });
    expect(forwarded[0]?.method).toBe("POST");
    expect(forwarded[0]?.headers.get("Origin")).toBe("https://console.example");
    expect(await forwarded[0]?.text()).toBe("{}");
  });

  it("serves /health itself, and anything else from the static files", async () => {
    const { forwarded, call } = setup();
    expect(await (await call("/health")).text()).toBe("1.2.3+abc");
    expect(await (await call("/")).text()).toBe("asset");
    expect(forwarded).toHaveLength(0);
  });
});
