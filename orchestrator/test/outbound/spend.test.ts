// Model spend (#92): what a call reserves, what it settles to, and that a run over
// its budget gets no further model responses.
import { env, runInDurableObject } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { handleOutbound } from "../../src/outbound/handler";
import type { RunScope } from "../../src/outbound/scope";
import { costOf, limits, parsePrices, readUsage, StreamUsage, worstCase, type Price } from "../../src/outbound/spend";
import type { RunState } from "../../src/run";
import { begin, scope, stubInternet } from "./helpers";

afterEach(() => {
  vi.restoreAllMocks();
});

const MODEL = "claude-sonnet-5-5";
const SONNET: Price = { input: 2, output: 10, cacheWrite5m: 2.5, cacheWrite1h: 4, cacheRead: 0.2 };

const testEnv = (overrides: Partial<Env> = {}): Env =>
  ({ ...env, ANTHROPIC_API_KEY: "model-key", MONTHLY_BUDGET_USD: "1000", ...overrides }) as Env;

/** A run on an issue of its own, so the issue's budget starts empty. */
async function startRun(): Promise<RunScope> {
  const run = scope({ issue: 1 + Math.floor(Math.random() * 1e9) });
  await begin(run);
  return run;
}

const callBody = (overrides: Record<string, unknown> = {}) =>
  JSON.stringify({ model: MODEL, max_tokens: 1000, messages: [{ role: "user", content: "Hi" }], ...overrides });

const call = (body = callBody(), path = "/v1/messages") =>
  new Request(`https://api.anthropic.com${path}`, { method: "POST", body, headers: { "anthropic-version": "2023-06-01" } });

const usage = (run: RunScope) => env.DELIVERY_LOG.getByName("global").runUsage(run.runId);

const stored = (run: RunScope, key: string) =>
  runInDurableObject(env.RUN_STATE.getByName(run.runId), (_instance: RunState, state) => state.storage.get(key));

function sse(events: object[]): string {
  return events.map((event) => `event: ${(event as { type: string }).type}\ndata: ${JSON.stringify(event)}\n\n`).join("");
}

const STREAM = sse([
  {
    type: "message_start",
    message: { usage: { input_tokens: 10, output_tokens: 1, cache_read_input_tokens: 1000, cache_creation_input_tokens: 0 } },
  },
  { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
  { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Hello" } },
  { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 50 } },
  { type: "message_stop" },
]);

describe("prices and usage", () => {
  it("bounds a call by its bytes at the dearest input rate, plus max_tokens at the output rate", () => {
    expect(worstCase(SONNET, 1000, 100)).toBe(1000 * 4 + 100 * 10);
  });

  it("prices each kind of token", () => {
    const tokens = { input: 10, output: 20, cacheRead: 300, cacheWrite5m: 40, cacheWrite1h: 50 };
    expect(costOf(SONNET, tokens)).toBe(10 * 2 + 20 * 10 + Math.ceil(300 * 0.2 + 40 * 2.5 + 50 * 4));
  });

  it("splits cache writes by lifetime, and counts an unsplit write at the 1-hour rate", () => {
    const split = { ephemeral_5m_input_tokens: 30, ephemeral_1h_input_tokens: 70 };
    expect(
      readUsage({ input_tokens: 1, output_tokens: 2, cache_creation_input_tokens: 100, cache_creation: split }),
    ).toMatchObject({ cacheWrite5m: 30, cacheWrite1h: 70 });
    expect(readUsage({ input_tokens: 1, output_tokens: 2, cache_creation_input_tokens: 100 })).toMatchObject({
      cacheWrite5m: 0,
      cacheWrite1h: 100,
    });
  });

  it("has no usage without both counts", () => {
    expect(readUsage({ input_tokens: 1 })).toBeNull();
    expect(readUsage({ input_tokens: -1, output_tokens: 2 })).toBeNull();
    expect(readUsage(null)).toBeNull();
  });

  it("reads a stream's usage across chunk boundaries, and only once it reaches message_stop", () => {
    const reader = new StreamUsage();
    const bytes = new TextEncoder().encode(STREAM);
    for (let at = 0; at < bytes.length; at += 7) reader.push(bytes.subarray(at, at + 7));
    expect(reader.result()).toEqual({ input: 10, output: 50, cacheRead: 1000, cacheWrite5m: 0, cacheWrite1h: 0 });

    const cut = new StreamUsage();
    cut.push(new TextEncoder().encode(STREAM.slice(0, STREAM.indexOf("message_stop"))));
    expect(cut.result()).toBeNull();

    const failed = new StreamUsage();
    failed.push(new TextEncoder().encode(STREAM + sse([{ type: "error", error: { type: "overloaded_error" } }])));
    expect(failed.result()).toBeNull();
  });

  it("drops an incomplete price, and refuses everything on bad settings", () => {
    expect(Object.keys(parsePrices(JSON.stringify({ a: SONNET, b: { input: 1 } })))).toEqual(["a"]);
    expect(parsePrices("not json")).toEqual({});
    expect(limits(testEnv({ RUN_BUDGET_USD: "abc", ISSUE_BUDGET_USD: "", MONTHLY_BUDGET_USD: "-1" }))).toMatchObject({
      run: 0,
      issue: 0,
      month: 0,
    });
  });

  it("prices both of the agent's models in the committed settings", () => {
    const prices = parsePrices(env.MODEL_PRICES);
    for (const model of (env.ALLOWED_MODELS ?? "").split(",")) expect(prices[model]).toBeDefined();
  });
});

describe("metered model calls", () => {
  it("settles a response to its usage", async () => {
    stubInternet(() => Response.json({ usage: { input_tokens: 100, output_tokens: 20 } }));
    const run = await startRun();
    const response = await handleOutbound(call(), run, testEnv());
    expect(response.status).toBe(200);
    await response.text();
    expect(await usage(run)).toEqual({ calls: 1, input: 100, output: 20, cacheRead: 0, cacheWrite: 0, cost: 400 });
  });

  it("passes a stream through unchanged and settles it from its events", async () => {
    stubInternet(() => new Response(STREAM, { headers: { "content-type": "text/event-stream" } }));
    const run = await startRun();
    const response = await handleOutbound(call(callBody({ stream: true })), run, testEnv());
    expect(await response.text()).toBe(STREAM);
    expect(await usage(run)).toMatchObject({ calls: 1, input: 10, output: 50, cacheRead: 1000, cost: 720 });
  });

  it("keeps the whole reservation for a stream that's cut off", async () => {
    const head = new TextEncoder().encode(STREAM.slice(0, 200));
    stubInternet(
      () =>
        new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(head);
            },
          }),
          { headers: { "content-type": "text/event-stream" } },
        ),
    );
    const run = await startRun();
    const body = callBody({ stream: true });
    const response = await handleOutbound(call(body), run, testEnv());
    const reader = response.body!.getReader();
    await reader.read();
    await reader.cancel();
    const expected = worstCase(SONNET, new TextEncoder().encode(body).byteLength, 1000);
    expect((await usage(run))?.cost).toBe(expected);
  });

  it("keeps the whole reservation when a response has no usage", async () => {
    stubInternet(() => Response.json({ content: [] }));
    const run = await startRun();
    const body = callBody();
    await (await handleOutbound(call(body), run, testEnv())).text();
    expect((await usage(run))?.cost).toBe(worstCase(SONNET, new TextEncoder().encode(body).byteLength, 1000));
  });

  it("charges nothing for an error", async () => {
    stubInternet(() => Response.json({ type: "error" }, { status: 529 }));
    const run = await startRun();
    const response = await handleOutbound(call(), run, testEnv());
    expect(response.status).toBe(529);
    expect((await usage(run))?.cost).toBe(0);
  });

  it("doesn't meter a free endpoint", async () => {
    const { calls } = stubInternet(() => Response.json({ input_tokens: 5 }));
    const run = await startRun();
    const body = JSON.stringify({ model: MODEL, messages: [{ role: "user", content: "Hi" }] });
    const response = await handleOutbound(call(body, "/v1/messages/count_tokens"), run, testEnv());
    expect(response.status).toBe(200);
    expect(calls).toHaveLength(1);
    expect(await usage(run)).toBeNull();
  });
});

describe("model calls the budget refuses", () => {
  it("gives a run over its budget no further model responses, and blocks it", async () => {
    // The first call fits, and costs $1.00, all of the run's budget.
    const { calls } = stubInternet(() => Response.json({ usage: { input_tokens: 0, output_tokens: 100_000 } }));
    const run = await startRun();
    const budget = testEnv({ RUN_BUDGET_USD: "1" });
    await (await handleOutbound(call(), run, budget)).text();
    expect(calls).toHaveLength(1);

    const refused = await handleOutbound(call(), run, budget);
    expect(refused.status).toBe(403);
    expect(await refused.text()).toContain("the run's $1.00 model budget is spent");
    expect(calls).toHaveLength(1);
    expect(await stored(run, "blocked")).toBe(true);
    expect(await stored(run, "notResumable")).toBeUndefined();
  });

  it("refuses a call whose worst case is more than the run has left, before sending it", async () => {
    const { calls } = stubInternet();
    const run = await startRun();
    // 1,000 output tokens can cost $0.01, and the run has $0.005.
    const response = await handleOutbound(call(), run, testEnv({ RUN_BUDGET_USD: "0.005" }));
    expect(response.status).toBe(403);
    expect(calls).toHaveLength(0);
  });

  it.each([
    ["issue", { ISSUE_BUDGET_USD: "0" }],
    ["month", { MONTHLY_BUDGET_USD: "0" }],
  ])("refuses a call over the %s's budget, and a resume can't renew it", async (budget, settings) => {
    const { calls } = stubInternet();
    const run = await startRun();
    const response = await handleOutbound(call(), run, testEnv(settings));
    expect(await response.text()).toContain(`the ${budget}'s $0.00 model budget is spent`);
    expect(calls).toHaveLength(0);
    expect(await stored(run, "notResumable")).toBe(true);
  });

  it.each([
    ["an unpriced model", testEnv({ MODEL_PRICES: "{}" }), callBody()],
    ["an oversized max_tokens", testEnv({ MAX_OUTPUT_TOKENS: "999" }), callBody()],
    ["no max_tokens", testEnv(), JSON.stringify({ model: MODEL, messages: [] })],
    ["unset budgets", testEnv({ RUN_BUDGET_USD: undefined }), callBody()],
  ])("refuses %s before sending anything", async (_name, settings, body) => {
    const { calls } = stubInternet();
    const response = await handleOutbound(call(body), await startRun(), settings);
    expect(response.status).toBe(403);
    expect(calls).toHaveLength(0);
  });

  it("counts a call in flight against the budget until it settles", async () => {
    // Each call's worst case is about $0.01, and the run has room for one at a time.
    const { calls } = stubInternet(() => Response.json({ usage: { input_tokens: 1, output_tokens: 1 } }));
    const run = await startRun();
    const budget = testEnv({ RUN_BUDGET_USD: "0.015" });
    const first = await handleOutbound(call(), run, budget);
    // The first response isn't read yet, so its reservation is still held.
    expect((await handleOutbound(call(), run, budget)).status).toBe(403);
    await first.text();
    // It settled at 12 micro-dollars, so the run has room again.
    expect((await handleOutbound(call(), run, budget)).status).toBe(200);
    expect(calls).toHaveLength(2);
  });
});
