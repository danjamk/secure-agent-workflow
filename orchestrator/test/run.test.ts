// How a run drives its container, with a fake container in place of the platform's.
// The live behavior is proven on the testbed (orchestrator/README.md, Live results).
import { env, runInDurableObject } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RUNNERS, runnerFor } from "../src/agents";
import { BACKGROUND_MODEL, MODEL } from "../src/agents/claude-code";
import { probeSlug } from "../src/agents/probe";
import type { RunState } from "../src/run";
import { interceptHosts, scrubOutput } from "../src/sandbox";
import { stubGitHub } from "./helpers";

afterEach(() => vi.restoreAllMocks());

const LOG = "/workspace/task/run.log";
const RESULT = "/workspace/task/result.json";

interface FakeOptions {
  /** Checks before the CA file appears. */
  caAfter?: number;
  /** The command's exit code, or null while it's still running. */
  exit?: string | null;
  /** Files the container holds, by path. */
  files?: Record<string, string>;
  /** The container stops on its own after starting. */
  dies?: boolean;
}

function fakeContainer(options: FakeOptions = {}) {
  const state = {
    running: false,
    started: [] as ContainerStartupOptions[],
    intercepted: [] as string[],
    allHttp: 0,
    commands: [] as { cmd: string[]; env?: Record<string, string>; user?: string }[],
    written: {} as Record<string, string>,
    destroyed: 0,
    caChecks: 0,
  };
  const encode = (text: string) => new TextEncoder().encode(text).buffer as ArrayBuffer;
  const container = {
    get running() {
      return state.running;
    },
    images: { agent: "registry.example/agent@sha256:abc" },
    start(startOptions: ContainerStartupOptions) {
      state.started.push(startOptions);
      state.running = !options.dies;
    },
    async setInactivityTimeout() {},
    async interceptOutboundHttps(host: string) {
      state.intercepted.push(host);
    },
    async interceptAllOutboundHttp() {
      state.allHttp += 1;
    },
    async interceptOutboundHttp() {
      state.allHttp += 1;
    },
    async destroy() {
      state.destroyed += 1;
      state.running = false;
    },
    async exec(cmd: string[], execOptions?: ContainerExecOptions) {
      let exitCode = 0;
      let stdout = "";
      if (cmd[0] === "test") {
        state.caChecks += 1;
        exitCode = state.caChecks > (options.caAfter ?? 0) ? 0 : 1;
      } else if (cmd[3] === "write-file") {
        const bytes = Uint8Array.from(atob(cmd[4] ?? ""), (c) => c.charCodeAt(0));
        state.written[cmd[5] ?? ""] = new TextDecoder().decode(bytes);
      } else if (cmd[0] === "/bin/sh") {
        state.commands.push({ cmd, env: execOptions?.env, user: execOptions?.user });
      } else if (cmd[0] === "cat") {
        const exit = options.exit === undefined ? "0" : options.exit;
        exitCode = exit === null ? 1 : 0;
        stdout = exit === null ? "" : `${exit}\n`;
      } else if (cmd[0] === "head") {
        const content = options.files?.[cmd[3] ?? ""];
        exitCode = content === undefined ? 1 : 0;
        stdout = content ?? "";
      }
      return {
        exitCode: Promise.resolve(exitCode),
        output: async () => ({ stdout: encode(stdout), stderr: encode(""), exitCode }),
      };
    },
  };
  return { container, state };
}

const SCOPE = {
  installationId: 99,
  repoId: 1234,
  repo: "the-approver/app",
  issue: 7,
  defaultBranch: "main",
};

/** A run in the "starting" phase with no alarm set, so the test drives each check. */
async function prepare(options: FakeOptions = {}, runner = "claude-code", deadline = Date.now() + 600_000) {
  const runId = crypto.randomUUID();
  const stub = env.RUN_STATE.getByName(runId);
  const fake = fakeContainer(options);
  await runInDurableObject(stub, async (_instance: RunState, state) => {
    await state.storage.put({ scope: { ...SCOPE, runId }, runner, phase: "starting", deadline });
  });
  const tick = () =>
    runInDurableObject(stub, async (instance: RunState) => {
      (instance as unknown as { container: () => unknown }).container = () => fake.container;
      await instance.alarm();
    });
  return { runId, stub, fake, tick };
}

type Calls = ReturnType<typeof stubGitHub>;
const posted = (calls: Calls) =>
  calls.filter((c) => c.method === "POST" && c.url.endsWith("/comments")).map((c) => (c.body as { body: string }).body);
const edited = (calls: Calls) =>
  calls.filter((c) => c.method === "PATCH").map((c) => (c.body as { body: string }).body);

describe("a run's container", () => {
  it("intercepts only the listed hosts, once, and starts the runner's instance with no internet", async () => {
    stubGitHub();
    const { fake, tick } = await prepare({ caAfter: 2, exit: null });
    for (let i = 0; i < 5; i += 1) await tick();
    expect(fake.state.intercepted).toEqual(["github.com", "api.github.com", "api.anthropic.com", "api.openai.com"]);
    expect(fake.state.allHttp).toBe(0);
    expect(fake.state.started).toEqual([
      { image: "registry.example/agent@sha256:abc", enableInternet: false, instance: "standard-1" },
    ]);
  });

  it("posts one status comment when the run starts", async () => {
    const calls = stubGitHub();
    const { runId, tick } = await prepare({ exit: null });
    await tick();
    await tick();
    expect(posted(calls)).toHaveLength(1);
    expect(posted(calls)[0]).toContain(`Run \`${runId}\``);
    expect(posted(calls)[0]).toContain("runner `claude-code`) started");
  });

  it("writes the issue and the instructions, then runs the agent as its own user with no credentials", async () => {
    stubGitHub();
    const { fake, tick } = await prepare({ caAfter: 1, exit: null });
    await tick(); // start
    await tick(); // no CA yet
    expect(fake.state.commands).toHaveLength(0);
    await tick(); // CA present
    expect(fake.state.written["/workspace/task/issue.md"]).toBe("# #7: Add a parser\n\nParse the config file.\n");
    expect(fake.state.written["/workspace/task/agent-instructions.md"]).toContain("# Build agent instructions");
    const [command] = fake.state.commands;
    expect(command?.cmd[2]).toContain("/agent/run-agent.sh > /workspace/task/run.log");
    expect(command?.user).toBe("1001:1001");
    expect(command?.env).toMatchObject({
      REPO: "the-approver/app",
      ISSUE: "7",
      MODEL,
      ANTHROPIC_DEFAULT_HAIKU_MODEL: BACKGROUND_MODEL,
      ANTHROPIC_API_KEY: "provided-by-the-worker",
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
      DISABLE_TELEMETRY: "1",
    });
    expect(JSON.stringify(command?.env)).not.toMatch(/minted-token|ghs_|sk-ant/);
  });

  it("edits the status comment with the agent's result and PR, tears down, releases the issue and stops", async () => {
    const calls = stubGitHub();
    const result = { type: "result", is_error: false, num_turns: 12, total_cost_usd: 0.42, result: "Opened the PR." };
    const { runId, stub, fake, tick } = await prepare({ files: { [RESULT]: JSON.stringify(result), [LOG]: "cloned" } });
    await env.DELIVERY_LOG.getByName("global").claimIssue("1234#7", runId);
    await stub.pinPullRequest(12, "PR_own");
    await tick(); // start
    await tick(); // agent starts
    await tick(); // agent finished
    expect(fake.state.destroyed).toBe(1);
    const [body] = edited(calls);
    expect(body).toContain("The agent finished (12 turns, about $0.42).");
    expect(body).toContain("PR: #12");
    expect(body).toContain("Opened the PR.");
    expect(await stub.admit()).toEqual({ admitted: false, reason: "the run is stopped" });
    expect(await env.DELIVERY_LOG.getByName("global").claimIssue("1234#7", "next")).toBe(true);
    expect(calls.map((c) => c.method).at(-1)).toBe("DELETE");
  });

  it("finds its start comment by run id when it didn't keep the id, and edits it", async () => {
    const runId = crypto.randomUUID();
    const calls = stubGitHub(undefined, [
      { id: 41, body: "Someone else's comment" },
      { id: 42, body: `Run \`${runId}\` (build \`x\`, runner \`claude-code\`) started.` },
    ]);
    const stub = env.RUN_STATE.getByName(runId);
    const fake = fakeContainer({ files: { [LOG]: "done" } });
    await runInDurableObject(stub, async (_instance: RunState, state) => {
      await state.storage.put({
        scope: { ...SCOPE, runId },
        runner: "probe",
        phase: "starting",
        deadline: Date.now() + 600_000,
        statusTried: true,
      });
    });
    for (let i = 0; i < 3; i += 1) {
      await runInDurableObject(stub, async (instance: RunState) => {
        (instance as unknown as { container: () => unknown }).container = () => fake.container;
        await instance.alarm();
      });
    }
    expect(posted(calls)).toHaveLength(0);
    expect(calls.filter((c) => c.method === "PATCH").map((c) => new URL(c.url).pathname)).toEqual([
      "/repos/the-approver/app/issues/comments/42",
    ]);
  });

  it("reports an agent that ended with an error", async () => {
    const calls = stubGitHub();
    const result = { type: "result", is_error: true, subtype: "error_max_turns", num_turns: 200 };
    const { tick } = await prepare({ exit: "1", files: { [RESULT]: JSON.stringify(result) } });
    await tick();
    await tick();
    await tick();
    expect(edited(calls)[0]).toContain("The agent failed (error_max_turns, 200 turns).");
  });

  it("reports an agent that left no result, with its log", async () => {
    const calls = stubGitHub();
    const { tick } = await prepare({ exit: "2", files: { [LOG]: "The clone failed." } });
    await tick();
    await tick();
    await tick();
    expect(edited(calls)[0]).toContain("The agent ended without a result (exit 2).");
    expect(edited(calls)[0]).toContain("The clone failed.");
  });

  it("runs the probe on a lite instance as root, and posts its output", async () => {
    const calls = stubGitHub();
    const { runId, fake, tick } = await prepare({ files: { [LOG]: "Results: 42 passed, 0 failed\n" } }, "probe");
    await tick();
    await tick();
    await tick();
    expect(fake.state.started[0]?.instance).toBe("lite");
    expect(fake.state.commands[0]?.user).toBeUndefined();
    expect(fake.state.commands[0]?.env).toMatchObject({ SLUG: probeSlug(runId) });
    expect(fake.state.written).toEqual({});
    expect(edited(calls)[0]).toContain("Every probe check passed.");
    expect(edited(calls)[0]).toContain("Results: 42 passed, 0 failed");
  });

  it("stops a run that passes its time limit, and still tears down", async () => {
    const calls = stubGitHub();
    const late = await prepare({ exit: null }, "claude-code", Date.now() - 1);
    late.fake.state.running = true;
    await late.tick();
    expect(late.fake.state.destroyed).toBe(1);
    expect(edited(calls).at(-1)).toContain("60-minute limit");
  });

  it("reports a container that stops on its own", async () => {
    const calls = stubGitHub();
    const { tick } = await prepare({ dies: true });
    await tick(); // start, and it dies
    await tick();
    expect(edited(calls)[0]).toContain("stopped before the run finished");
  });

  it("does nothing more once the run is done", async () => {
    const calls = stubGitHub();
    const { fake, tick } = await prepare();
    await tick();
    await tick();
    await tick();
    const count = calls.length;
    await tick();
    expect(calls.length).toBe(count);
    expect(fake.state.started).toHaveLength(1);
  });

  it("starts once for a repeated launch, and refuses an unknown runner", async () => {
    const calls = stubGitHub();
    const runId = crypto.randomUUID();
    const stub = env.RUN_STATE.getByName(runId);
    await stub.launch({ ...SCOPE, runId }, "claude-code");
    await runInDurableObject(stub, async (_instance: RunState, state) => {
      await state.storage.put("deadline", 1);
    });
    await stub.launch({ ...SCOPE, runId, issue: 8 }, "claude-code");
    await runInDurableObject(stub, async (_instance: RunState, state) => {
      expect((await state.storage.get<{ issue: number }>("scope"))?.issue).toBe(7);
      expect(await state.storage.get("deadline")).toBe(1);
    });
    const refused = await env.RUN_STATE.getByName(crypto.randomUUID())
      .launch({ ...SCOPE, runId: "x" }, "nope")
      .then(() => null, (error: Error) => error);
    expect(refused?.message).toContain("no runner named nope");
    // The launch's own alarm runs with no container and reports that. Let it finish
    // before the GitHub stub is removed.
    await vi.waitFor(() => expect(calls.map((c) => c.method)).toContain("DELETE"));
  });
});

describe("runners", () => {
  it("picks the probe only for an issue labeled agent:probe", () => {
    expect(runnerFor(["agent:ready"]).name).toBe("claude-code");
    expect(runnerFor(["agent:ready", "agent:probe"]).name).toBe("probe");
    expect(Object.keys(RUNNERS).sort()).toEqual(["claude-code", "probe"]);
  });

  it("allows both of the agent's models", () => {
    const allowed = (env as unknown as { ALLOWED_MODELS: string }).ALLOWED_MODELS;
    expect(allowed.split(",")).toEqual(expect.arrayContaining([MODEL, BACKGROUND_MODEL]));
  });

  it("cuts a very long issue body", () => {
    const files = RUNNERS["claude-code"]!.files({
      scope: { ...SCOPE, runId: "r" },
      issue: { title: "t", body: "x".repeat(70_000) },
      env,
    });
    expect(files["/workspace/task/issue.md"]!.length).toBeLessThan(61_000);
  });
});

describe("hosts and output", () => {
  it("adds the repo's registries to the hosts", () => {
    const hosts = interceptHosts(
      { ...env, EGRESS_HOSTS: JSON.stringify({ "the-approver/app": ["registry.npmjs.org", "github.com"] }) } as Env,
      "the-approver/app",
    );
    expect(hosts).toEqual(["github.com", "api.github.com", "api.anthropic.com", "api.openai.com", "registry.npmjs.org"]);
  });

  it("refuses more hosts than the platform allows", () => {
    const many = Array.from({ length: 130 }, (_, i) => `registry${i}.example`);
    expect(() =>
      interceptHosts({ ...env, EGRESS_HOSTS: JSON.stringify({ "the-approver/app": many }) } as Env, "the-approver/app"),
    ).toThrow();
  });

  it.each([
    ["an installation token", "ghs_abcdefghijklmnopqrstuvwxyz0123", "ghs_"],
    ["a personal token", "ghp_abcdefghijklmnopqrstuvwxyz0123", "ghp_"],
    ["a fine-grained token", "github_pat_11ABCDEFG0123456789_abcdefghij", "github_pat_"],
    ["a model key", "sk-ant-api03-abcdefghijklmnop", "sk-ant"],
    ["a token in a URL", "https://x-access-token:secretvalue@github.com/a/b", "secretvalue"],
    ["a private key", "-----BEGIN RSA PRIVATE KEY-----\nMIIabc\n-----END RSA PRIVATE KEY-----", "MIIabc"],
  ])("scrubs %s from output", (_name, text, secret) => {
    const scrubbed = scrubOutput(`before ${text} after`);
    expect(scrubbed).toContain("[removed]");
    expect(scrubbed).not.toContain(secret);
    expect(scrubbed).toMatch(/^before .* after$/s);
  });

  it("scrubs the run's own token, caps the length and keeps the code block closed", () => {
    expect(scrubOutput("leaked plain-token-value here", ["plain-token-value"])).toBe("leaked [removed] here");
    expect(scrubOutput("x".repeat(70_000)).length).toBeLessThan(61_000);
    expect(scrubOutput("```\nescaped")).toBe("'''\nescaped");
  });

  it("names the probe's branch from the run id", () => {
    expect(probeSlug("8F2A1C3E-1111-2222-3333-444455556666")).toBe("probe-8f2a1c3e");
  });
});
