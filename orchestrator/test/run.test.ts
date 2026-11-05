// How a run drives its container, with a fake container in place of the platform's.
// The live behavior is proven on the testbed (orchestrator/README.md, Live results).
import { env, runInDurableObject } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { RunState } from "../src/run";
import { interceptHosts, probeEnv, probeSlug, scrubOutput } from "../src/sandbox";
import { stubGitHub } from "./helpers";

afterEach(() => vi.restoreAllMocks());

interface FakeOptions {
  /** Ticks before the CA file appears. */
  caAfter?: number;
  /** The probe's exit code, or null while it's still running. */
  exit?: string | null;
  output?: string;
  /** The container stops on its own after starting. */
  dies?: boolean;
}

function fakeContainer(options: FakeOptions = {}) {
  const state = {
    running: false,
    started: [] as ContainerStartupOptions[],
    intercepted: [] as string[],
    allHttp: 0,
    commands: [] as { cmd: string[]; env?: Record<string, string> }[],
    destroyed: 0,
    caChecks: 0,
  };
  const encode = (text: string) => new TextEncoder().encode(text).buffer as ArrayBuffer;
  const container = {
    get running() {
      return state.running;
    },
    images: { probe: "registry.example/probe@sha256:abc" },
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
      state.commands.push({ cmd, env: execOptions?.env });
      let exitCode = 0;
      let stdout = "";
      if (cmd[0] === "test") {
        state.caChecks += 1;
        exitCode = state.caChecks > (options.caAfter ?? 0) ? 0 : 1;
      } else if (cmd[0] === "cat") {
        const exit = options.exit === undefined ? "0" : options.exit;
        exitCode = exit === null ? 1 : 0;
        stdout = exit === null ? "" : `${exit}\n`;
      } else if (cmd[0] === "head") {
        stdout = options.output ?? "PASS  everything\n";
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

/** A run in the "starting" phase with no alarm set, so the test drives each tick. */
async function prepare(options: FakeOptions = {}, deadline = Date.now() + 600_000) {
  const runId = crypto.randomUUID();
  const stub = env.RUN_STATE.getByName(runId);
  const fake = fakeContainer(options);
  await runInDurableObject(stub, async (instance: RunState, state) => {
    await state.storage.put({ scope: { ...SCOPE, runId }, phase: "starting", deadline });
    (instance as unknown as { container: () => unknown }).container = () => fake.container;
  });
  const tick = () =>
    runInDurableObject(stub, async (instance: RunState) => {
      (instance as unknown as { container: () => unknown }).container = () => fake.container;
      await instance.alarm();
    });
  return { runId, stub, fake, tick };
}

function comments(calls: ReturnType<typeof stubGitHub>): string[] {
  return calls.filter((c) => c.url.endsWith("/comments")).map((c) => (c.body as { body: string }).body);
}

describe("a run's container", () => {
  it("intercepts only the listed hosts, then starts with no internet on a lite instance", async () => {
    stubGitHub();
    const { fake, tick } = await prepare();
    await tick();
    expect(fake.state.intercepted).toEqual(["github.com", "api.github.com", "api.anthropic.com", "api.openai.com"]);
    expect(fake.state.intercepted).not.toContain("*");
    expect(fake.state.allHttp).toBe(0);
    expect(fake.state.started).toEqual([
      { image: "registry.example/probe@sha256:abc", enableInternet: false, instance: "lite" },
    ]);
  });

  it("waits for the CA, then runs the probe with no credentials in its environment", async () => {
    stubGitHub();
    const { runId, fake, tick } = await prepare({ caAfter: 1, exit: null });
    await tick(); // start
    await tick(); // no CA yet
    expect(fake.state.commands.filter((c) => c.cmd[0] === "/bin/sh")).toHaveLength(0);
    await tick(); // CA present, probe starts
    const probe = fake.state.commands.find((c) => c.cmd[0] === "/bin/sh");
    expect(probe?.env).toEqual(probeEnv({ ...SCOPE, runId }, probeSlug(runId)));
    expect(JSON.stringify(probe?.env)).not.toMatch(/token|key|secret/i);
  });

  it("posts the probe's output, tears down, and stops the run", async () => {
    const calls = stubGitHub();
    const { stub, fake, tick } = await prepare({ output: "PASS  one\nResults: 1 passed, 0 failed\n" });
    await tick(); // start
    await tick(); // probe starts
    await tick(); // probe finished
    expect(fake.state.destroyed).toBe(1);
    const [body] = comments(calls);
    expect(body).toContain("Every probe check passed.");
    expect(body).toContain("Results: 1 passed, 0 failed");
    expect(await stub.admit()).toEqual({ admitted: false, reason: "the run is stopped" });
    expect(calls.map((c) => c.method).at(-1)).toBe("DELETE");
  });

  it("reports failed checks with the exit code", async () => {
    const calls = stubGitHub();
    const { tick } = await prepare({ exit: "1", output: "FAIL  push to main\n" });
    await tick();
    await tick();
    await tick();
    expect(comments(calls)[0]).toContain("Some probe checks failed (exit 1).");
  });

  it("stops a run that passes its time limit, and still tears down", async () => {
    const calls = stubGitHub();
    const late = await prepare({ exit: null }, Date.now() - 1);
    late.fake.state.running = true;
    await late.tick();
    expect(late.fake.state.destroyed).toBe(1);
    expect(comments(calls).at(-1)).toContain("time limit");
  });

  it("reports a container that stops on its own", async () => {
    const calls = stubGitHub();
    const { tick } = await prepare({ dies: true });
    await tick(); // start, and it dies
    await tick();
    expect(comments(calls)[0]).toContain("stopped before the probe finished");
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

  it("starts once for a repeated launch", async () => {
    const calls = stubGitHub();
    const runId = crypto.randomUUID();
    const stub = env.RUN_STATE.getByName(runId);
    await stub.launch({ ...SCOPE, runId });
    await runInDurableObject(stub, async (_instance: RunState, state) => {
      await state.storage.put("deadline", 1);
    });
    await stub.launch({ ...SCOPE, runId, issue: 8 });
    await runInDurableObject(stub, async (_instance: RunState, state) => {
      expect((await state.storage.get<{ issue: number }>("scope"))?.issue).toBe(7);
      expect(await state.storage.get("deadline")).toBe(1);
    });
    // The launch's own alarm runs with no container and reports that. Let it finish
    // before the GitHub stub is removed.
    await vi.waitFor(() => expect(calls.map((c) => c.method)).toContain("DELETE"));
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
