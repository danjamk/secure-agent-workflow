// Part of test:security. The coordinator decides when a released issue may start:
// a free slot, its blockers done on evidence the agent can't fake, and its touch
// areas free (ADR-005, #13).
import { env, runInDurableObject } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { QueueEntry, Snapshot } from "../src/coordinator";
import type { RunState } from "../src/run";
import { deliver, release, runFinished, stubGitHub } from "./helpers";

afterEach(() => vi.restoreAllMocks());

/** A coordinator of its own, so each test starts with an empty queue. */
const fresh = () => env.DELIVERY_LOG.getByName(`coordinator-${crypto.randomUUID()}`);

function entry(issue: number, snapshot: Partial<Snapshot> = {}, overrides: Partial<QueueEntry> = {}): QueueEntry {
  return {
    issue: `1234#${issue}`,
    run: `run-${issue}-${crypto.randomUUID()}`,
    kind: "new",
    scope: { installationId: 99, repoId: 1234, repo: "the-approver/app", issue, defaultBranch: "main" },
    runner: "claude-code",
    resume: null,
    snapshot: { title: `Issue ${issue}`, body: "", blockers: [], areas: ["area:api"], ...snapshot },
    ...overrides,
  };
}

const started = (launches: { entry: QueueEntry }[]) => launches.map((launch) => launch.entry.issue);

describe("slots", () => {
  it("starts no more than the cap, and the next one when a run ends", async () => {
    const log = fresh();
    const one = entry(1, { areas: ["area:a"] });
    await log.enqueue(one);
    await log.enqueue(entry(2, { areas: ["area:b"] }));
    expect(started(await log.pump(1))).toEqual(["1234#1"]);
    expect(await log.queueState()).toMatchObject([{ issue: "1234#2", waiting: "no free slot" }]);
    expect(started(await log.pump(1))).toEqual([]);
    await log.runEnded("1234#1", one.run, false);
    expect(started(await log.pump(1))).toEqual(["1234#2"]);
  });

  it("starts as many as the cap allows, in the order they were released", async () => {
    const log = fresh();
    for (const n of [3, 1, 2]) await log.enqueue(entry(n, { areas: [`area:${n}`] }));
    expect(started(await log.pump(2))).toEqual(["1234#3", "1234#1"]);
  });

  it("puts a resume ahead of new issues", async () => {
    const log = fresh();
    await log.enqueue(entry(1, { areas: ["area:a"] }));
    await log.enqueue(entry(2, { areas: ["area:b"] }, { kind: "resume" }));
    expect(started(await log.pump(1))).toEqual(["1234#2"]);
  });

  it("refuses a second entry for an issue that's queued or running", async () => {
    const log = fresh();
    await log.enqueue(entry(1));
    expect(await log.enqueue(entry(1))).toEqual({ queued: false, reason: "the issue is already queued" });
    await log.pump(1);
    expect(await log.enqueue(entry(1))).toEqual({ queued: false, reason: "a run is already active on this issue" });
  });
});

describe("dependencies", () => {
  it("holds an issue until each blocker is completed, and doesn't block the issues behind it", async () => {
    const log = fresh();
    await log.enqueue(entry(1, { blockers: ["the-approver/app#5"], areas: ["area:a"] }));
    await log.enqueue(entry(2, { areas: ["area:b"] }));
    expect(started(await log.pump(5))).toEqual(["1234#2"]);
    expect(await log.queueState()).toMatchObject([{ issue: "1234#1", waiting: "blocked by the-approver/app#5" }]);
    await log.markCompleted("the-approver/app#5", "closed by the approver");
    expect(started(await log.pump(5))).toEqual(["1234#1"]);
  });

  it("completes an issue when the PR its run opened merges into the default branch, and only then", async () => {
    const log = fresh();
    await log.enqueue(entry(1, { blockers: ["the-approver/app#5"] }));
    // A PR no run opened, and the run's PR merged into another branch, don't count.
    expect(await log.pullRequestClosed(1234, 40, true)).toBeNull();
    await log.recordPullRequest("1234#5", "the-approver/app#5", 1234, 41);
    expect(await log.pullRequestClosed(1234, 41, false)).toBe("1234#5");
    expect(started(await log.pump(5))).toEqual([]);
    expect(await log.pullRequestClosed(1234, 41, true)).toBe("1234#5");
    expect(started(await log.pump(5))).toEqual(["1234#1"]);
  });
});

describe("touch areas", () => {
  it("runs two issues in the same area one after the other, and different areas side by side", async () => {
    const log = fresh();
    const first = entry(1, { areas: ["area:api"] });
    await log.enqueue(first);
    await log.enqueue(entry(2, { areas: ["area:api"] }));
    await log.enqueue(entry(3, { areas: ["area:ui"] }));
    expect(started(await log.pump(5))).toEqual(["1234#1", "1234#3"]);
    expect(await log.queueState()).toMatchObject([{ issue: "1234#2", waiting: "area:api is held by 1234#1" }]);
  });

  it("keeps the area while the run's PR is open, and frees it when the PR closes", async () => {
    const log = fresh();
    const first = entry(1);
    await log.enqueue(first);
    await log.pump(5);
    await log.recordPullRequest("1234#1", "the-approver/app#1", 1234, 50);
    await log.runEnded("1234#1", first.run, true);
    await log.enqueue(entry(2));
    expect(started(await log.pump(5))).toEqual([]);
    await log.pullRequestClosed(1234, 50, false);
    expect(started(await log.pump(5))).toEqual(["1234#2"]);
  });

  it("frees the area when a run ends without keeping it", async () => {
    const log = fresh();
    const first = entry(1);
    await log.enqueue(first);
    await log.pump(5);
    await log.runEnded("1234#1", first.run, false);
    await log.enqueue(entry(2));
    expect(started(await log.pump(5))).toEqual(["1234#2"]);
  });

  it("locks the whole repo for an issue with no area label, but not other repos", async () => {
    const log = fresh();
    await log.enqueue(entry(1, { areas: [] }));
    await log.enqueue(entry(2, { areas: ["area:ui"] }));
    const elsewhere = entry(3, { areas: ["area:ui"] });
    elsewhere.issue = "5678#3";
    elsewhere.scope = { ...elsewhere.scope, repoId: 5678, repo: "the-approver/other" };
    await log.enqueue(elsewhere);
    expect(started(await log.pump(5))).toEqual(["1234#1", "5678#3"]);
    expect(await log.queueState()).toMatchObject([{ issue: "1234#2", waiting: "the repo is locked by 1234#1" }]);
  });
});

describe("stops and generations", () => {
  it("takes a stopped issue out of the queue and frees its areas", async () => {
    const log = fresh();
    const first = entry(1);
    await log.enqueue(first);
    await log.pump(5);
    await log.enqueue(entry(2));
    expect(await log.dequeue("1234#1")).toBe(false);
    expect(started(await log.pump(5))).toEqual(["1234#2"]);
    expect(await log.dequeue("1234#2")).toBe(false);
    await log.enqueue(entry(3, { areas: ["area:other"] }));
    expect(await log.dequeue("1234#3")).toBe(true);
    expect(await log.queueState()).toEqual([]);
  });

  it("drops an entry from before a stop, so it can't start the work again", async () => {
    const log = fresh();
    const first = entry(1);
    const queued = await log.enqueue(first);
    const [launch] = await log.pump(5);
    await log.dequeue("1234#1");
    // The start failed and came back to the queue, after the stop.
    await log.unlaunch(launch!.entry, queued.queued ? queued.generation : 0);
    expect(started(await log.pump(5))).toEqual([]);
    expect(await log.queueState()).toEqual([]);
  });
});

describe("a run's PR", () => {
  it("is recorded when the run pins it, so its merge completes the issue", async () => {
    const runId = crypto.randomUUID();
    const stub = env.RUN_STATE.getByName(runId);
    await stub.begin({ runId, installationId: 99, repoId: 1234, repo: "The-Approver/App", issue: 74, defaultBranch: "main" });
    await stub.pinPullRequest(174, "PR_node");
    const log = env.DELIVERY_LOG.getByName("global");
    // The repo's name is matched in lower case, as blockers are.
    expect(await log.pullRequestClosed(1234, 174, true)).toBe("1234#74");
    const blocked = fresh();
    await blocked.markCompleted("the-approver/app#74", "PR #174 merged");
    await blocked.enqueue(entry(75, { blockers: ["the-approver/app#74"] }));
    expect(started(await blocked.pump(5))).toEqual(["1234#75"]);
  });
});

describe("through the webhook", () => {
  const blocker = { number: 5, repository_url: "https://api.github.com/repos/the-approver/app" };
  const closedBy = (login: string, type: string, state_reason = "completed") => ({
    action: "closed",
    sender: { login, type },
    repository: { full_name: "the-approver/app", id: 1234, default_branch: "main" },
    issue: { number: 5, state: "closed", state_reason },
    installation: { id: 99 },
  });

  it("snapshots blockers at release, and starts the issue when the approver closes its blocker", async () => {
    const calls = stubGitHub(undefined, [], { private: false }, [blocker]);
    const issue = { number: 71, state: "open", title: "Add a parser", body: "Parse the config.", labels: [{ name: "area:parse" }] };
    const response = await deliver(release({ issue }));
    expect(await response.json()).toMatchObject({ started: false, waiting: "blocked by the-approver/app#5" });

    // The agent App closing the blocker isn't evidence.
    expect(await (await deliver(closedBy("danjamk-build-agent[bot]", "Bot"))).json()).toEqual({ ignored: "sender isn't the approver" });
    // Closed as not planned doesn't complete it either.
    await deliver(closedBy("the-approver", "User", "not_planned"));
    const log = env.DELIVERY_LOG.getByName("global");
    expect((await log.queueState()).find((row) => row.issue === "1234#71")?.waiting).toBe("blocked by the-approver/app#5");

    const closing = await deliver(closedBy("the-approver", "User"));
    expect(closing.status).toBe(202);
    expect((await log.queueState()).find((row) => row.issue === "1234#71")).toBeUndefined();
    expect(await log.activeRun("1234#71")).not.toBeNull();
    await runFinished(calls);
  });

  it("gives the run the issue as released, not as edited later", async () => {
    const calls = stubGitHub();
    const delivery = crypto.randomUUID();
    const issue = { number: 72, state: "open", title: "As released", body: "The approved text.", labels: [] };
    await deliver(release({ issue }), { delivery });
    await runInDurableObject(env.RUN_STATE.getByName(delivery), async (_instance: RunState, state) => {
      expect(await state.storage.get("issue")).toMatchObject({ title: "As released", body: "The approved text." });
    });
    await runFinished(calls);
  });

  it("frees a run's areas and completes its issue when its PR merges, and ignores other PRs", async () => {
    stubGitHub();
    const log = env.DELIVERY_LOG.getByName("global");
    await log.recordPullRequest("1234#73", "the-approver/app#73", 1234, 173);
    const closedPr = (number: number, merged: boolean, base = "main") => ({
      action: "closed",
      sender: { login: "someone", type: "User" },
      repository: { full_name: "the-approver/app", id: 1234, default_branch: "main" },
      pull_request: { number, merged, base: { ref: base } },
      installation: { id: 99 },
    });
    const other = await deliver(closedPr(999, true), { event: "pull_request" });
    expect(await other.json()).toEqual({ ignored: "not a run's PR" });
    const merged = await deliver(closedPr(173, true), { event: "pull_request" });
    expect(await merged.json()).toMatchObject({ issue: "1234#73", completed: true });
  });
});
