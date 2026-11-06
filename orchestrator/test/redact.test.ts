// Part of test:security. A run's log is redacted before it's stored (#10, red-team
// scenario 9): a run that prints each credential the Worker holds stores only
// redacted text.
import { env, runInDurableObject } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { credentialValues, redact, REMOVED } from "../src/redact";
import { LOG_RETENTION_MS, MAX_LOG_BYTES, takeLines, type RunState } from "../src/run";
import { fakeContainer, stubGitHub, type FakeOptions } from "./helpers";

afterEach(() => vi.restoreAllMocks());

const EVENTS = "/workspace/task/events.jsonl";
const LOG = "/workspace/task/run.log";
const SCOPE = { installationId: 99, repoId: 1234, repo: "the-approver/app", issue: 7, defaultBranch: "main" };

const KEY = env.GITHUB_APP_PRIVATE_KEY ?? "";
const KEY_LINES = KEY.split("\n").filter((line) => line && !line.startsWith("-----"));
const TOKEN = `ghs_${"a1B2c3D4".repeat(5)}`;

/** Every credential the Worker holds, and the token formats it doesn't. */
const LEAKS: [string, string][] = [
  ["the App's private key", KEY],
  ["one line of the private key", KEY_LINES[3] ?? ""],
  ["the webhook secret", env.GITHUB_WEBHOOK_SECRET ?? ""],
  ["the Anthropic key", env.ANTHROPIC_API_KEY ?? ""],
  ["the OpenAI key", env.OPENAI_API_KEY ?? ""],
  ["an installation token", TOKEN],
  ["a token as git's Basic auth", btoa(`x-access-token:${TOKEN}`)],
  ["a personal access token", `github_pat_${"x9".repeat(20)}`],
  // Built from parts, so the gate's secret scan doesn't take these fakes for real ones.
  ["an AWS key id", ["AKIA", "ABCDEFGHIJKLMNOP"].join("")],
  ["a JWT", ["eyJhbGciOiJSUzI1NiJ9", "eyJpc3MiOiIxMjM0NSJ9", "c2lnbmF0dXJlLXZhbHVl"].join(".")],
];

/** How the agent's event stream carries text: one JSON object per line. */
const event = (text: string) => `${JSON.stringify({ type: "user", message: { content: text } })}\n`;

describe("redaction", () => {
  const secrets = credentialValues(env, [TOKEN]);

  it("lists every credential the Worker holds, the key line by line, and the token's Basic form", () => {
    expect(secrets).toEqual(
      expect.arrayContaining([
        KEY.trim(),
        ...KEY_LINES,
        env.GITHUB_WEBHOOK_SECRET,
        env.ANTHROPIC_API_KEY,
        env.OPENAI_API_KEY,
        TOKEN,
        btoa(`x-access-token:${TOKEN}`),
      ]),
    );
    expect(credentialValues({ ...env, GITHUB_WEBHOOK_SECRET: "short" } as Env)).not.toContain("short");
  });

  it.each(LEAKS)("removes %s, as it is and inside JSON", (_name, value) => {
    expect(value.length).toBeGreaterThan(8);
    for (const text of [`before ${value} after`, event(`before ${value} after`)]) {
      const result = redact(text, secrets);
      expect(result.text).not.toContain(value);
      expect(result.text).not.toContain(JSON.stringify(value).slice(1, -1));
      expect(result.text).toContain(REMOVED);
      expect(result.count).toBeGreaterThan(0);
    }
  });

  it("leaves ordinary text alone", () => {
    const text = event("Ran make check: 12 passed. Opened PR #12.");
    expect(redact(text, secrets)).toEqual({ text, count: 0 });
  });

  it("stores whole lines, and splits a long one where a credential can't be", () => {
    const bytes = (text: string) => new TextEncoder().encode(text);
    expect(takeLines(bytes("one\ntwo\nthr"), false, false)).toBe(8);
    expect(takeLines(bytes("partial"), false, false)).toBe(0);
    expect(takeLines(bytes("partial"), false, true)).toBe(7);
    expect(takeLines(bytes('{"a":"bcd","e'), true, false)).toBe(12);
  });
});

/** A run in the running phase, driven one check at a time. */
async function prepare(options: FakeOptions) {
  const runId = crypto.randomUUID();
  const stub = env.RUN_STATE.getByName(runId);
  const fake = fakeContainer(options);
  fake.state.running = true;
  await runInDurableObject(stub, async (_instance: RunState, state) => {
    await state.storage.put({
      scope: { ...SCOPE, runId },
      runner: "claude-code",
      phase: "running",
      deadline: Date.now() + 600_000,
      started: true,
      statusTried: true,
    });
  });
  const tick = () =>
    runInDurableObject(stub, async (instance: RunState) => {
      (instance as unknown as { container: () => unknown }).container = () => fake.container;
      await instance.alarm();
    });
  return { stub, fake, tick };
}

describe("a run's log", () => {
  it("stores only redacted text when the run prints each credential", async () => {
    const calls = stubGitHub();
    const files = {
      [EVENTS]: LEAKS.map(([name, value]) => event(`${name}: ${value}`)).join(""),
      [LOG]: `Claude Code exited 0.\nThe webhook secret is ${env.GITHUB_WEBHOOK_SECRET}\n`,
    };
    const { stub, tick } = await prepare({ files, exit: "0" });
    await tick();
    const log = await stub.readLog();
    expect(log).toContain("the webhook secret: [removed]");
    for (const [, value] of LEAKS) {
      expect(log).not.toContain(value);
      expect(log).not.toContain(JSON.stringify(value).slice(1, -1));
    }
    for (const line of KEY_LINES) expect(log).not.toContain(line);
    const comment = calls.filter((c) => c.method === "POST" && c.url.endsWith("/comments")).at(-1);
    expect((comment?.body as { body: string }).body).toMatch(/Log: 12 lines stored, \d+ credentials removed, kept until \d{4}-\d{2}-\d{2}\./);
    expect((comment?.body as { body: string }).body).not.toContain(env.GITHUB_WEBHOOK_SECRET);
  });

  it("doesn't store a line until it's whole, so a credential split across reads is still found", async () => {
    stubGitHub();
    const line = event(`key: ${env.ANTHROPIC_API_KEY}`);
    const half = line.indexOf(env.ANTHROPIC_API_KEY ?? "") + 10;
    const options: FakeOptions = { files: { [EVENTS]: event("first") + line.slice(0, half) }, exit: null };
    const { stub, tick } = await prepare(options);
    await tick();
    expect(await stub.readLog()).toBe(event("first"));
    options.files![EVENTS] = event("first") + line;
    await tick();
    const log = await stub.readLog();
    expect(log).toBe(event("first") + event(`key: ${REMOVED}`));
  });

  it("reads each source from where it left off", async () => {
    stubGitHub();
    const options: FakeOptions = { files: { [EVENTS]: event("one") }, exit: null };
    const { stub, tick } = await prepare(options);
    await tick();
    options.files![EVENTS] = event("one") + event("two");
    await tick();
    await tick();
    expect(await stub.readLog()).toBe(event("one") + event("two"));
  });

  it("stops storing at the size limit, and says so", async () => {
    stubGitHub();
    const line = event("x".repeat(1000));
    const options: FakeOptions = { files: { [EVENTS]: line.repeat(Math.ceil((MAX_LOG_BYTES * 1.1) / line.length)) }, exit: null };
    const { stub, fake, tick } = await prepare(options);
    for (let i = 0; i < 14; i += 1) await tick();
    const log = await stub.readLog();
    expect(log.length).toBeLessThanOrEqual(MAX_LOG_BYTES + 100);
    expect(log.endsWith("[log cut at 10 MB]\n")).toBe(true);
    // Once full, the run reads no more.
    const reads = fake.state.logReads;
    await tick();
    expect(fake.state.logReads).toBe(reads);
  });

  it("keeps the log for the retention period, then deletes the run and refuses to start it again", async () => {
    stubGitHub();
    const { stub, tick } = await prepare({ files: { [EVENTS]: event("done") }, exit: "0" });
    const before = Date.now();
    await tick();
    expect(await stub.readLog()).toBe(event("done"));
    await runInDurableObject(stub, async (_instance: RunState, state) => {
      const purgeAt = (await state.storage.get<number>("purgeAt")) ?? 0;
      expect(purgeAt).toBeGreaterThanOrEqual(before + LOG_RETENTION_MS);
      expect(await state.storage.getAlarm()).toBe(purgeAt);
      // Not due yet: nothing is deleted.
      await (_instance as unknown as { alarm: () => Promise<void> }).alarm();
      expect(await state.storage.get("scope")).toBeDefined();
      await state.storage.put("purgeAt", Date.now() - 1);
    });
    await tick();
    expect(await stub.readLog()).toBe("");
    await stub.launch({ ...SCOPE, runId: "again" }, "claude-code");
    await runInDurableObject(stub, async (_instance: RunState, state) => {
      expect(await state.storage.get("scope")).toBeUndefined();
      expect(await state.storage.get("purged")).toBe(true);
    });
  });
});
