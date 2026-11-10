// Part of test:security. The reconciler catches up on webhooks GitHub didn't deliver,
// trusting who did something from GitHub's records, never a label's presence (#110).
import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { QueueEntry } from "../src/coordinator";
import { reconcile } from "../src/reconcile";

afterEach(() => vi.restoreAllMocks());

const REPO = "the-approver/app";
const log = () => env.DELIVERY_LOG.getByName("global");

interface World {
  ready: { number: number; title: string; body: string; labels: { name: string }[] }[];
  events: Record<number, { event: string; label: { name: string }; actor: { login: string; type: string }; created_at: string }[]>;
  pulls: Record<number, { state: string; merged: boolean; base: { ref: string } }>;
  issues: Record<number, { state: string; state_reason: string | null; closed_by: { login: string; type: string } | null }>;
}

/** GitHub as the reconciler sees it. Calls a run makes get a plain success. */
function stubWorld(world: Partial<World>) {
  const w: World = { ready: [], events: {}, pulls: {}, issues: {}, ...world };
  const calls: string[] = [];
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const request = new Request(input, init);
    const { pathname, search } = new URL(request.url);
    calls.push(`${request.method} ${pathname}${search}`);
    if (pathname.endsWith("/access_tokens")) {
      return Response.json(
        { token: "minted-token", expires_at: new Date(Date.now() + 3600_000).toISOString(), repositories: [{ id: 1234 }] },
        { status: 201 },
      );
    }
    if (pathname === "/installation/token") return new Response(null, { status: 204 });
    if (request.method === "GET" && pathname === `/repos/${REPO}/issues` && search.includes("agent%3Aready")) return Response.json(w.ready);
    let match = /^\/repos\/the-approver\/app\/issues\/(\d+)\/events$/.exec(pathname);
    if (match) return Response.json(w.events[Number(match[1])] ?? []);
    if (/\/dependencies\/blocked_by$/.test(pathname)) return Response.json([]);
    match = /^\/repos\/the-approver\/app\/pulls\/(\d+)$/.exec(pathname);
    if (match) return w.pulls[Number(match[1])] ? Response.json(w.pulls[Number(match[1])]) : new Response("", { status: 404 });
    match = /^\/repos\/the-approver\/app\/issues\/(\d+)$/.exec(pathname);
    if (match && request.method === "GET") {
      const issue = w.issues[Number(match[1])];
      return Response.json(issue ?? { state: "open", title: "An issue", body: "" });
    }
    if (request.method === "POST" && pathname.endsWith("/comments")) return Response.json({ id: 1 }, { status: 201 });
    if (request.method === "PATCH") return Response.json({ id: 1 });
    if (request.method === "GET" && pathname === `/repos/${REPO}`) return Response.json({ private: false });
    return Response.json([]);
  });
  return calls;
}

const labeled = (login: string, type: string, at: string) => ({
  event: "labeled",
  label: { name: "agent:ready" },
  actor: { login, type },
  created_at: at,
});

const ready = (number: number, labels: string[] = []) => ({
  number,
  title: `Issue ${number}`,
  body: "As released.",
  labels: [{ name: "agent:ready" }, ...labels.map((name) => ({ name }))],
});

function entry(issue: number, areas: string[], blockers: string[] = []): QueueEntry {
  return {
    issue: `1234#${issue}`,
    run: crypto.randomUUID(),
    kind: "new",
    scope: { installationId: 99, repoId: 1234, repo: REPO, issue, defaultBranch: "main" },
    runner: "claude-code",
    resume: null,
    snapshot: { title: `Issue ${issue}`, body: "", blockers, areas },
  };
}

/** Waits for a run the reconciler started to edit its status comment and revoke its token. */
async function runFinished(calls: string[]): Promise<void> {
  await vi.waitFor(() => {
    const edit = calls.findIndex((call) => call.startsWith("PATCH"));
    expect(edit).toBeGreaterThanOrEqual(0);
    expect(calls.slice(edit).some((call) => call.startsWith("DELETE"))).toBe(true);
  });
}

beforeEach(async () => {
  await log().recordRepo(1234, REPO, 99, "main");
});

describe("missed releases", () => {
  it("queues an issue the approver labeled, once", async () => {
    const calls = stubWorld({
      ready: [ready(80)],
      events: { 80: [labeled("the-approver", "User", new Date(Date.now() - 60_000).toISOString())] },
    });
    expect((await reconcile(env)).released).toEqual([`${REPO}#80`]);
    expect(await log().activeRun("1234#80")).not.toBeNull();
    await runFinished(calls);
    // The label is still there after the run, but it was acted on.
    expect((await reconcile(env)).released).toEqual([]);
  });

  it.each([
    ["the agent App labeled it", ready(81), [labeled("danjamk-build-agent[bot]", "Bot", new Date(Date.now() - 60_000).toISOString())]],
    ["it also has agent:stop", ready(82, ["agent:stop"]), [labeled("the-approver", "User", new Date(Date.now() - 60_000).toISOString())]],
    ["nobody ever added the label", ready(83), []],
  ])("ignores an issue when %s", async (_name, issue, events) => {
    stubWorld({ ready: [issue], events: { [issue.number]: events } });
    expect((await reconcile(env)).released).toEqual([]);
  });

  it("ignores a label added before the issue's last release", async () => {
    const calls = stubWorld({ ready: [ready(84)], events: { 84: [labeled("the-approver", "User", new Date(Date.now() - 3_600_000).toISOString())] } });
    await log().enqueue(entry(84, ["area:recon-84"]));
    await log().dequeue("1234#84");
    expect((await reconcile(env)).released).toEqual([]);
    expect(calls.some((call) => call.includes("/issues/84/events"))).toBe(true);
  });
});

describe("a release the webhook refused", () => {
  it("isn't acted on later, after the run that was active ends", async () => {
    const calls = stubWorld({ ready: [ready(92)], events: { 92: [labeled("the-approver", "User", new Date(Date.now() - 1000).toISOString())] } });
    // A run is active, so the approver's second agent:ready is refused, but noted.
    await log().claimIssue("1234#92", "active-run");
    const { queueRelease } = await import("../src/coordinator");
    const refused = await queueRelease(
      { repo: REPO, repoId: 1234, defaultBranch: "main", number: 92, installationId: 99, labels: [], title: "t", body: "" },
      crypto.randomUUID(),
      env,
    );
    expect(refused).toEqual({ queued: false, reason: "a run is already active on this issue" });
    await log().releaseIssue("1234#92", "active-run");
    expect((await reconcile(env)).released).toEqual([]);
    expect(calls.some((call) => call.includes("/issues/92/events"))).toBe(true);
  });
});

describe("missed PR closes and blocker closes", () => {
  it("frees the areas of an issue whose PR merged, and completes it", async () => {
    stubWorld({ pulls: { 185: { state: "closed", merged: true, base: { ref: "main" } } } });
    const locked = entry(85, ["area:recon-85"]);
    await log().enqueue(locked);
    await log().pump(100);
    await log().recordPullRequest("1234#85", `${REPO}#85`, 1234, 185);
    await log().runEnded("1234#85", locked.run, true);
    expect((await reconcile(env)).prsClosed).toEqual([`${REPO}#185`]);
    expect((await log().lockedIssues(1234)).map((row) => row.issue)).not.toContain("1234#85");
    // Done: an issue blocked by it isn't held up.
    await log().enqueue(entry(90, ["area:recon-90"], [`${REPO}#85`, `${REPO}#99`]));
    expect(await log().pendingBlockers()).toEqual([`${REPO}#99`]);
    await log().dequeue("1234#90");
  });

  it("completes a blocker the approver closed, and not one the App closed", async () => {
    stubWorld({
      issues: {
        87: { state: "closed", state_reason: "completed", closed_by: { login: "the-approver", type: "User" } },
        88: { state: "closed", state_reason: "completed", closed_by: { login: "danjamk-build-agent[bot]", type: "Bot" } },
      },
    });
    await log().enqueue(entry(86, ["area:recon-86"], [`${REPO}#87`, `${REPO}#88`]));
    expect((await reconcile(env)).blockersDone).toEqual([`${REPO}#87`]);
    expect(await log().pendingBlockers()).toEqual([`${REPO}#88`]);
    await log().dequeue("1234#86");
  });
});

describe("stale slots", () => {
  it("frees a slot whose run never started, after a grace period", async () => {
    stubWorld({});
    await log().enqueue(entry(89, ["area:recon-89"]));
    await log().pump(100, Date.now() - 10 * 60 * 1000);
    expect(await log().activeRun("1234#89")).not.toBeNull();
    expect((await reconcile(env)).slotsFreed).toContain("1234#89");
    expect(await log().activeRun("1234#89")).toBeNull();
  });

  it("leaves a slot taken moments ago alone", async () => {
    stubWorld({});
    await log().enqueue(entry(91, ["area:recon-91"]));
    await log().pump(100);
    expect((await reconcile(env)).slotsFreed).not.toContain("1234#91");
    await log().releaseIssue("1234#91", (await log().activeRun("1234#91")) ?? "");
  });
});
