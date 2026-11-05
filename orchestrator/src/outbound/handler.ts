import { WorkerEntrypoint } from "cloudflare:workers";
import type { Admission } from "../run";
import { decideGit, decidePush, scanCommands } from "./git";
import { decideGraphql } from "./graphql";
import { decideModel, MODEL_HOSTS, parseModels, type ModelHost } from "./models";
import { decideRest } from "./rest";
import type { Pins, RunScope } from "./scope";

const MAX_PUSH_COMMANDS = 64 * 1024;
const MAX_API_BODY = 1024 * 1024;
const MAX_MODEL_BODY = 32 * 1024 * 1024;

/**
 * The only headers that leave the sandbox, so Authorization, Cookie, Proxy-*, X-Forwarded-*
 * and X-HTTP-Method-Override can't. Accept-Encoding is left to the Workers runtime.
 */
const HEADERS = ["accept", "content-type", "user-agent", "if-none-match", "if-modified-since"];
const GIT_HEADERS = ["git-protocol"];
const API_HEADERS = ["x-github-api-version"];
const REGISTRY_HEADERS = ["range"];

const REDIRECTS = new Set([301, 302, 303, 307, 308]);

/** Release downloads, for a repo that lists github.com in its registries. */
const RELEASE_PATH = /^\/[\w.-]+\/[\w.-]+\/releases\/download\/[\w./+-]+$/;

function denied(scope: RunScope, request: Request, reason: string, status = 403): Response {
  const { hostname } = new URL(request.url);
  // The path and query stay out of the log, because they could hold what's being sent out.
  console.warn(JSON.stringify({ run: scope.runId, denied: reason, method: request.method, host: hostname }));
  return new Response(`Blocked by the outbound policy: ${reason}\n`, { status });
}

function pickHeaders(request: Request, names: string[]): Headers {
  const headers = new Headers();
  for (const name of [...HEADERS, ...names]) {
    const value = request.headers.get(name);
    if (value !== null) headers.set(name, value);
  }
  return headers;
}

/** The whole body as text, or null if it's over the limit or isn't UTF-8. */
async function readText(request: Request, max: number): Promise<string | null> {
  if (!request.body) return "";
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let at = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, at);
    at += chunk.byteLength;
  }
  try {
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes);
  } catch {
    return null;
  }
}

async function readJson(request: Request, max: number): Promise<{ value: unknown } | null> {
  const text = await readText(request, max);
  if (text === null) return null;
  try {
    return { value: JSON.parse(text) };
  } catch {
    return null;
  }
}

/** Removes what the sandbox has no use for, and any redirect from a call with a credential. */
function respond(response: Response, authenticated: boolean): Response {
  // A Location can hold a signed URL, such as for a tarball, and it's refused rather
  // than followed so a credential never reaches another origin.
  if (authenticated && REDIRECTS.has(response.status)) {
    return new Response("Blocked by the outbound policy: redirect refused\n", { status: 502 });
  }
  const headers = new Headers(response.headers);
  headers.delete("set-cookie");
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

function send(url: URL, method: string, headers: Headers, body?: BodyInit | null): Promise<Response> {
  // Rebuilt from what was checked. No userinfo, no port and no fragment reach GitHub.
  return fetch(`https://${url.hostname}${url.pathname}${url.search}`, {
    method,
    headers,
    body: body ?? undefined,
    redirect: "manual",
  });
}

function concat(first: Uint8Array, second: Uint8Array): Uint8Array {
  const joined = new Uint8Array(first.byteLength + second.byteLength);
  joined.set(first);
  joined.set(second, first.byteLength);
  return joined;
}

/** Puts back what was read to check the commands, ahead of the rest of the push. */
function replay(head: Uint8Array, reader: ReadableStreamDefaultReader<Uint8Array>): ReadableStream {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(head);
    },
    async pull(controller) {
      const { done, value } = await reader.read();
      if (done) controller.close();
      else controller.enqueue(value);
    },
    cancel(reason) {
      return reader.cancel(reason);
    },
  });
}

class Route {
  constructor(
    readonly request: Request,
    readonly url: URL,
    readonly scope: RunScope,
    readonly env: Env,
    readonly run: DurableObjectStub<import("../run").RunState>,
    readonly pins: Pins,
  ) {}

  deny(reason: string, status?: number): Response {
    return denied(this.scope, this.request, reason, status);
  }

  async github(names: string[], authorization: (token: string) => string, body?: BodyInit | null) {
    const headers = pickHeaders(this.request, names);
    headers.set("authorization", authorization(await this.run.accessToken()));
    // GitHub refuses a request with no User-Agent.
    if (!headers.has("user-agent")) headers.set("user-agent", "secure-agent-workflow");
    // A string is a body this handler rebuilt as JSON.
    if (typeof body === "string") headers.set("content-type", "application/json");
    return send(this.url, this.request.method, headers, body);
  }

  async git(): Promise<Response> {
    const { request, url, scope, pins } = this;
    const decision = decideGit(request.method, url.pathname, url.search, scope);
    if (!decision.allow) return this.releaseDownload(decision.reason);

    const basic = (token: string) => `Basic ${btoa(`x-access-token:${token}`)}`;
    if (decision.call === "read") {
      return respond(await this.github(GIT_HEADERS, basic), true);
    }
    if (decision.call === "fetch") {
      const gzip = request.headers.get("content-encoding");
      const names = gzip ? [...GIT_HEADERS, "content-encoding"] : GIT_HEADERS;
      return respond(await this.github(names, basic, request.body), true);
    }

    // A push. Encoding would hide the commands.
    if (request.headers.has("content-encoding")) return this.deny("push: encoded body");
    if (!request.body) return this.deny("push: empty body");
    const reader = request.body.getReader() as ReadableStreamDefaultReader<Uint8Array>;
    let head: Uint8Array = new Uint8Array();
    for (;;) {
      const scan = scanCommands(head);
      if (scan.kind === "bad") return this.deny(scan.reason);
      if (scan.kind === "flush") {
        const verdict = decidePush(scan.lines, scope, pins);
        if (!verdict.allow) return this.deny(verdict.reason);
        if (verdict.ref === null) {
          // git's probe is a flush and nothing else.
          const next = await reader.read();
          if (!next.done || head.byteLength !== scan.end) return this.deny("push: data after an empty command list");
          return respond(await this.github(GIT_HEADERS, basic, head), true);
        }
        if (!(await this.run.pinBranch(verdict.ref))) return this.deny("push: the run already has a branch");
        return respond(await this.github(GIT_HEADERS, basic, replay(head, reader)), true);
      }
      const { done, value } = await reader.read();
      if (done) return this.deny("push: incomplete commands");
      head = concat(head, value);
      if (head.byteLength > MAX_PUSH_COMMANDS && scanCommands(head).kind === "more") {
        return this.deny("push: too many commands");
      }
    }
  }

  async releaseDownload(reason: string): Promise<Response> {
    const { request, url } = this;
    const allowed =
      registries(this.env, this.scope.repo).has("github.com") &&
      (request.method === "GET" || request.method === "HEAD") &&
      RELEASE_PATH.test(url.pathname) &&
      !url.search;
    if (!allowed) return this.deny(reason);
    return respond(await send(url, request.method, pickHeaders(request, REGISTRY_HEADERS)), false);
  }

  async api(): Promise<Response> {
    const { request, url, scope, pins } = this;
    const bearer = (token: string) => `Bearer ${token}`;
    const read = request.method === "GET" || request.method === "HEAD";

    if (url.pathname === "/graphql") {
      if (request.method !== "POST" || url.search) return this.deny("graphql: POST only");
      const parsed = await readJson(request, MAX_API_BODY);
      if (!parsed) return this.deny("graphql: bad body");
      const decision = decideGraphql(parsed.value, pins);
      if (!decision.allow) return this.deny(decision.reason);
      return respond(await this.github(API_HEADERS, bearer, decision.body), true);
    }

    if (!read && url.search) return this.deny("rest: no query on a write");
    const parsed = read ? { value: undefined } : await readJson(request, MAX_API_BODY);
    if (!parsed) return this.deny("rest: bad body");
    const decision = decideRest(request.method, url.pathname, parsed.value, scope, pins);
    if (!decision.allow) return this.deny(decision.reason);

    const response = await this.github(API_HEADERS, bearer, decision.body);
    if (decision.pinPullRequest && response.status === 201) {
      const created = (await response.clone().json()) as { number?: unknown; node_id?: unknown };
      if (typeof created.number !== "number" || typeof created.node_id !== "string") {
        return this.deny("rest: GitHub's PR response has no number", 502);
      }
      await this.run.pinPullRequest(created.number, created.node_id);
    }
    return respond(response, true);
  }

  async model(host: ModelHost): Promise<Response> {
    const { request, url, env } = this;
    const key = env[host.secret];
    if (!key) return this.deny(`model: ${host.secret} isn't set`, 503);
    const parsed = await readJson(request, MAX_MODEL_BODY);
    if (!parsed) return this.deny("model: bad body");
    const decision = decideModel(
      host,
      request.method,
      url.pathname,
      url.search,
      parsed.value,
      parseModels(env.ALLOWED_MODELS),
    );
    if (!decision.allow) return this.deny(decision.reason);
    const headers = pickHeaders(request, host.headers);
    headers.set(host.header, host.header === "authorization" ? `Bearer ${key}` : key);
    headers.set("content-type", "application/json");
    return respond(await send(url, request.method, headers, decision.body), true);
  }

  async registry(): Promise<Response> {
    const { request, url } = this;
    if (request.method !== "GET" && request.method !== "HEAD") return this.deny("registry: read only");
    return respond(await send(url, request.method, pickHeaders(request, REGISTRY_HEADERS)), false);
  }
}

/** Hosts one repo may read packages from. A bad setting means none. */
export function registries(env: Env, repo: string): Set<string> {
  try {
    const all = JSON.parse(env.EGRESS_HOSTS ?? "{}") as Record<string, unknown>;
    const hosts = Object.hasOwn(all, repo) ? all[repo] : [];
    return new Set(Array.isArray(hosts) ? hosts.filter((host) => typeof host === "string") : []);
  } catch {
    console.error("EGRESS_HOSTS isn't valid JSON, so no registries are allowed");
    return new Set();
  }
}

/** Every request from a run's container comes through here. Anything unlisted is denied. */
export async function handleOutbound(request: Request, scope: RunScope, env: Env): Promise<Response> {
  try {
    const url = new URL(request.url);
    // A credential on plain HTTP would cross the internet unencrypted.
    if (url.protocol !== "https:" || url.port || url.username || url.password) {
      return denied(scope, request, "https on the default port only");
    }

    // Before anything else, so a stopped run gets nothing, even a package.
    const run = env.RUN_STATE.getByName(scope.runId);
    const admission: Admission = await run.admit();
    if (!admission.admitted) return denied(scope, request, admission.reason);

    const route = new Route(request, url, scope, env, run, admission);
    if (url.hostname === "github.com") return await route.git();
    if (url.hostname === "api.github.com") return await route.api();
    const model = Object.hasOwn(MODEL_HOSTS, url.hostname) ? MODEL_HOSTS[url.hostname] : undefined;
    if (model) return await route.model(model);
    if (registries(env, scope.repo).has(url.hostname)) return await route.registry();
    return denied(scope, request, "host not allowed");
  } catch (error) {
    // Only the type: a message could hold a response from GitHub.
    console.error(`Outbound handler failed: ${(error as Error).name}`);
    return denied(scope, request, "the outbound handler failed", 503);
  }
}

/**
 * Registered with interceptOutboundHttps for each host in interceptHosts()
 * (src/sandbox.ts). The policy still decides every request those hosts receive.
 */
export class Outbound extends WorkerEntrypoint<Env, RunScope> {
  override fetch(request: Request): Promise<Response> {
    return handleOutbound(request, this.ctx.props, this.env);
  }
}
