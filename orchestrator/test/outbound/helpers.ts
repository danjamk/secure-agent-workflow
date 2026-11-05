import { env } from "cloudflare:test";
import { vi } from "vitest";
import type { Pins, RunScope } from "../../src/outbound/scope";

export const REPO = "the-approver/app";
export const API = `https://api.github.com/repos/${REPO}`;
export const GIT = `https://github.com/${REPO}.git`;
export const TOKEN = "minted-run-token";
export const BRANCH = "refs/heads/agent/7-add-parser";
export const PR = { number: 12, nodeId: "PR_own" };

export const ZERO = "0".repeat(40);
export const OLD = "a".repeat(40);
export const NEW = "b".repeat(40);

export function scope(overrides: Partial<RunScope> = {}): RunScope {
  return {
    runId: crypto.randomUUID(),
    installationId: 99,
    repoId: 1234,
    repo: REPO,
    issue: 7,
    defaultBranch: "main",
    ...overrides,
  };
}

export const noPins: Pins = { branch: null, pr: null };
export const pinned: Pins = { branch: BRANCH, pr: PR };

export interface Forwarded {
  method: string;
  url: string;
  headers: Headers;
  body: Uint8Array;
  redirect: string;
}

/**
 * Stand-in for the internet. Records what the handler sent onward, and answers with
 * `answer`. Token mints and revocations are answered here and kept out of the record.
 */
export function stubInternet(
  answer: (call: Forwarded) => Response = () => new Response("ok"),
  mint: { expiresInMs?: number; repositories?: { id: number }[] } = {},
): {
  calls: Forwarded[];
  mints: () => number;
  revocations: () => number;
} {
  let revocations = 0;
  const calls: Forwarded[] = [];
  let mints = 0;
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const request = new Request(input, init);
    if (request.url.endsWith("/access_tokens")) {
      mints += 1;
      return Response.json(
        {
          token: TOKEN,
          expires_at: new Date(Date.now() + (mint.expiresInMs ?? 3600_000)).toISOString(),
          repositories: mint.repositories ?? [{ id: 1234 }],
        },
        { status: 201 },
      );
    }
    if (request.url.endsWith("/installation/token")) {
      revocations += 1;
      return new Response(null, { status: 204 });
    }
    const call: Forwarded = {
      method: request.method,
      url: request.url,
      headers: request.headers,
      body: new Uint8Array(await request.arrayBuffer()),
      redirect: request.redirect,
    };
    calls.push(call);
    return answer(call);
  });
  return { calls, mints: () => mints, revocations: () => revocations };
}

/** Starts a run's state, with anything it has already pinned. */
export async function begin(run: RunScope, pins: Partial<Pins> = {}): Promise<void> {
  const stub = env.RUN_STATE.getByName(run.runId);
  await stub.begin(run);
  if (pins.branch) await stub.pinBranch(pins.branch);
  if (pins.pr) await stub.pinPullRequest(pins.pr.number, pins.pr.nodeId);
}

export function pkt(text: string): Uint8Array {
  const bytes = new TextEncoder().encode(text);
  const length = (bytes.length + 4).toString(16).padStart(4, "0");
  return new TextEncoder().encode(length + text);
}

export const FLUSH = new TextEncoder().encode("0000");

export function join(...parts: Uint8Array[]): Uint8Array<ArrayBuffer> {
  const joined = new Uint8Array(parts.reduce((size, part) => size + part.length, 0));
  let at = 0;
  for (const part of parts) {
    joined.set(part, at);
    at += part.length;
  }
  return joined;
}

export function command(ref: string, next = NEW, old = OLD, capabilities = "report-status-v2 agent=git/2.50"): Uint8Array {
  return pkt(`${old} ${next} ${ref}\0${capabilities}\n`);
}
