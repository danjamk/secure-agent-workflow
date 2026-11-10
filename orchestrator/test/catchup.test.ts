// Part of test:security. An agent PR that conflicts with the default branch gets a
// catch-up run on its own branch: one per default branch commit, two in all, then
// it's handed to the approver (#111, ADR-005).
import { env } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { claudeCode } from "../src/agents/claude-code";
import { queueCatchUps, type QueueEntry } from "../src/coordinator";

afterEach(() => vi.restoreAllMocks());

const REPO = { name: "the-approver/other", repoId: 4321, defaultBranch: "main", installationId: 99 };
const log = () => env.DELIVERY_LOG.getByName("global");
const fresh = () => env.DELIVERY_LOG.getByName(`catchup-${crypto.randomUUID()}`);

interface Pull {
  state?: string;
  mergeable_state: string;
  base?: string;
}

/** GitHub for the conflict check: the default branch's commit and each PR's state. */
function stubPulls(head: string, pulls: Record<number, Pull>) {
  const calls: { method: string; path: string; body: unknown }[] = [];
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const request = new Request(input, init);
    const { pathname } = new URL(request.url);
    const text = await request.text();
    calls.push({ method: request.method, path: pathname, body: text ? JSON.parse(text) : undefined });
    if (pathname === `/repos/${REPO.name}/branches/main`) return Response.json({ commit: { sha: head } });
    const match = /\/pulls\/(\d+)$/.exec(pathname);
    if (match) {
      const pull = pulls[Number(match[1])];
      if (!pull) return new Response("", { status: 404 });
      return Response.json({
        state: pull.state ?? "open",
        merged: false,
        mergeable_state: pull.mergeable_state,
        base: { ref: pull.base ?? "main" },
        head: { ref: `agent/${match[1]}-branch` },
        node_id: `PR_${match[1]}`,
      });
    }
    if (request.method === "POST") return Response.json({ id: 1 }, { status: 201 });
    return Response.json([]);
  });
  return calls;
}

/** An issue whose run opened a PR and holds an area, as after its run ended. */
async function openPr(issue: number, pr: number, area: string): Promise<void> {
  const entry: QueueEntry = {
    issue: `4321#${issue}`,
    run: crypto.randomUUID(),
    kind: "new",
    scope: { installationId: 99, repoId: 4321, repo: REPO.name, issue, defaultBranch: "main" },
    runner: "claude-code",
    resume: null,
    snapshot: { title: `Issue ${issue}`, body: "", blockers: [], areas: [area] },
  };
  await log().enqueue(entry);
  await log().pump(100);
  await log().recordPullRequest(`4321#${issue}`, `${REPO.name}#${issue}`, 4321, pr);
  await log().runEnded(`4321#${issue}`, entry.run, true);
}

const queuedFor = async (issue: number) => (await log().queueState()).find((row) => row.issue === `4321#${issue}`);

describe("the catch-up record", () => {
  it("allows one catch-up per default branch commit, two in all, then hands the PR over once", async () => {
    const record = fresh();
    expect(await record.catchUp(1, 10, "a")).toBe("run");
    expect(await record.catchUp(1, 10, "a")).toBe("already");
    expect(await record.catchUp(1, 10, "b")).toBe("run");
    expect(await record.catchUp(1, 10, "c")).toBe("give up");
    expect(await record.catchUp(1, 10, "d")).toBe("given up");
    // Another PR has its own count.
    expect(await record.catchUp(1, 11, "c")).toBe("run");
  });
});

describe("queueing catch-ups", () => {
  it("queues a catch-up on the PR's branch, inside the areas its issue holds", async () => {
    stubPulls("sha-1", { 301: { mergeable_state: "dirty" } });
    await openPr(101, 301, "area:catchup-a");
    expect(await queueCatchUps(env, REPO, "token")).toEqual([301]);
    expect(await queuedFor(101)).toMatchObject({ kind: "catchup" });
    // Not again for the same default branch commit, or while one is queued.
    expect(await queueCatchUps(env, REPO, "token")).toEqual([]);
    await log().dequeue("4321#101");
    await log().pullRequestClosed(4321, 301, false);
  });

  it("checks the other PRs when one can't be read", async () => {
    stubPulls("sha-4", { 305: { mergeable_state: "dirty" } });
    await openPr(104, 304, "area:catchup-d");
    await openPr(105, 305, "area:catchup-e");
    expect(await queueCatchUps(env, REPO, "token")).toEqual([305]);
    await log().dequeue("4321#105");
    await log().pullRequestClosed(4321, 304, false);
    await log().pullRequestClosed(4321, 305, false);
  });

  it.each([
    ["a PR that merges cleanly", { mergeable_state: "clean" }],
    ["a PR GitHub hasn't worked out yet", { mergeable_state: "unknown" }],
    ["a PR into another branch", { mergeable_state: "dirty", base: "release" }],
    ["a closed PR", { mergeable_state: "dirty", state: "closed" }],
  ])("leaves %s alone", async (_name, pull) => {
    stubPulls("sha-2", { 302: pull });
    await openPr(102, 302, "area:catchup-b");
    expect(await queueCatchUps(env, REPO, "token")).toEqual([]);
    await log().pullRequestClosed(4321, 302, false);
  });

  it("marks the issue blocked and comments on the PR after two catch-ups that didn't fix it", async () => {
    await openPr(103, 303, "area:catchup-c");
    await log().catchUp(4321, 303, "old-1");
    await log().catchUp(4321, 303, "old-2");
    const calls = stubPulls("sha-3", { 303: { mergeable_state: "dirty" } });
    expect(await queueCatchUps(env, REPO, "token")).toEqual([]);
    expect(await queuedFor(103)).toBeUndefined();
    expect(calls).toContainEqual({ method: "POST", path: `/repos/${REPO.name}/issues/103/labels`, body: { labels: ["agent:blocked"] } });
    const comment = calls.find((call) => call.path === `/repos/${REPO.name}/issues/303/comments`);
    expect((comment?.body as { body: string }).body).toContain("after two catch-up runs");
    // Only once.
    const before = calls.length;
    await queueCatchUps(env, REPO, "token");
    expect(calls.slice(before).filter((call) => call.method === "POST")).toEqual([]);
    await log().pullRequestClosed(4321, 303, false);
  });

  it("goes ahead of new issues", async () => {
    const queue = fresh();
    const base = { run: "r", scope: { installationId: 99, repoId: 4321, repo: REPO.name, issue: 1, defaultBranch: "main" }, runner: "claude-code", resume: null };
    await queue.enqueue({ ...base, issue: "4321#1", kind: "new", snapshot: { title: "t", body: "", blockers: [], areas: ["area:x"] } });
    await queue.enqueue({ ...base, issue: "4321#2", kind: "catchup", snapshot: { title: "", body: "", blockers: [], areas: ["area:y"] } });
    expect((await queue.pump(1)).map((launch) => launch.entry.issue)).toEqual(["4321#2"]);
  });
});

describe("the catch-up run", () => {
  it("tells the runner it's a catch-up, and writes no reply", () => {
    const context = {
      scope: { runId: "r", installationId: 99, repoId: 4321, repo: REPO.name, issue: 101, defaultBranch: "main" },
      issue: { title: "t", body: "b" },
      resume: { branch: "agent/101-branch", pr: 301, reply: "", catchup: true },
      env,
    };
    const { env: runEnv } = claudeCode.command(context);
    expect(runEnv).toMatchObject({ CATCHUP: "1", RESUMED: "1", RESUME_BRANCH: "agent/101-branch", RESUME_PR: "301" });
    expect(Object.keys(claudeCode.files(context))).not.toContain("/workspace/task/reply.md");
  });
});
