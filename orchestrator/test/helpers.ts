import { env, SELF } from "cloudflare:test";
import { vi } from "vitest";

export const SECRET = "test-webhook-secret";

export async function sign(body: string, secret = SECRET): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body));
  const hex = [...new Uint8Array(mac)].map((b) => b.toString(16).padStart(2, "0")).join("");
  return `sha256=${hex}`;
}

/** A release that passes every check. Tests change one field at a time. */
export function release(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    action: "labeled",
    label: { name: "agent:ready" },
    sender: { login: "the-approver", type: "User" },
    repository: { full_name: "the-approver/app", id: 1234, default_branch: "main" },
    issue: { number: 7, state: "open" },
    installation: { id: 99 },
    ...overrides,
  };
}

export async function deliver(
  payload: unknown,
  options: { event?: string; delivery?: string; signature?: string | null } = {},
): Promise<Response> {
  const body = typeof payload === "string" ? payload : JSON.stringify(payload);
  const signature = options.signature === undefined ? await sign(body) : options.signature;
  const headers: Record<string, string> = {
    "X-GitHub-Event": options.event ?? "issues",
    "X-GitHub-Delivery": options.delivery ?? crypto.randomUUID(),
  };
  if (signature !== null) headers["X-Hub-Signature-256"] = signature;
  return SELF.fetch("https://orchestrator.test/webhook", { method: "POST", headers, body });
}

export interface Call {
  method: string;
  url: string;
  authorization: string | null;
  body: unknown;
}

/**
 * Stand-in for GitHub. Records calls; `mint` overrides the token response, and
 * `comments` is what listing an issue's comments returns.
 */
export function stubGitHub(mint?: () => Response, comments: { id: number; body: string }[] = []): Call[] {
  const calls: Call[] = [];
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const request = new Request(input, init);
    const text = await request.text();
    calls.push({
      method: request.method,
      url: request.url,
      authorization: request.headers.get("Authorization"),
      body: text ? JSON.parse(text) : undefined,
    });
    if (request.url.endsWith("/access_tokens")) {
      if (mint) return mint();
      return Response.json(
        {
          token: "minted-token",
          expires_at: new Date(Date.now() + 3600_000).toISOString(),
          repositories: [{ id: 1234, full_name: "the-approver/app" }],
        },
        { status: 201 },
      );
    }
    if (request.method === "GET" && /\/issues\/\d+\/comments\?/.test(request.url)) return Response.json(comments);
    if (request.url.endsWith("/comments")) return Response.json({ id: 1 }, { status: 201 });
    if (/\/issues\/\d+\/labels/.test(request.url)) return Response.json([]);
    if (request.method === "PATCH" && /\/issues\/comments\/\d+$/.test(request.url)) {
      return Response.json({ id: 1 });
    }
    if (request.method === "GET" && /\/issues\/\d+$/.test(request.url)) {
      return Response.json({ title: "Add a parser", body: "Parse the config file." });
    }
    if (request.url.endsWith("/installation/token")) return new Response(null, { status: 204 });
    return new Response("unexpected", { status: 500 });
  });
  return calls;
}

export function testEnv(): Env & { TEST_PUBLIC_KEY: string } {
  return env as unknown as Env & { TEST_PUBLIC_KEY: string };
}

export interface FakeOptions {
  /** Checks before the CA file appears. */
  caAfter?: number;
  /** The command's exit code, or null while it's still running. */
  exit?: string | null;
  /** Files the container holds, by path. */
  files?: Record<string, string>;
  /** The container stops on its own after starting. */
  dies?: boolean;
}

/** Stands in for the platform's container. Tests can change `state.running`. */
export function fakeContainer(options: FakeOptions = {}) {
  const state = {
    running: false,
    started: [] as ContainerStartupOptions[],
    intercepted: [] as string[],
    allHttp: 0,
    commands: [] as { cmd: string[]; env?: Record<string, string>; user?: string }[],
    written: {} as Record<string, string>,
    destroyed: 0,
    caChecks: 0,
    logReads: 0,
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
      let raw: Uint8Array | null = null;
      if (cmd[0] === "test") {
        state.caChecks += 1;
        exitCode = state.caChecks > (options.caAfter ?? 0) ? 0 : 1;
      } else if (cmd[3] === "write-file") {
        const bytes = Uint8Array.from(atob(cmd[4] ?? ""), (c) => c.charCodeAt(0));
        state.written[cmd[5] ?? ""] = new TextDecoder().decode(bytes);
      } else if (cmd[3] === "read-log") {
        // tail -c +N <path> | head -c <max>, from the file as it is now.
        state.logReads += 1;
        const content = options.files?.[cmd[5] ?? ""];
        const start = Number(cmd[4]) - 1;
        raw = new TextEncoder().encode(content ?? "").slice(start, start + Number(cmd[6]));
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
        output: async () => ({ stdout: raw ? (raw.buffer as ArrayBuffer) : encode(stdout), stderr: encode(""), exitCode }),
      };
    },
  };
  return { container, state };
}

