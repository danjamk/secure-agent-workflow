// The test:security suite for #11: stop, blocked and resume, through the webhook
// and the run, with a fake container and GitHub stubbed.
import { env, runInDurableObject } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { handleOutbound } from "../src/outbound/handler";
import type { RunState } from "../src/run";
import { deliver, fakeContainer, release, stubGitHub, type FakeOptions } from "./helpers";

afterEach(() => vi.restoreAllMocks());

const SCOPE = { installationId: 99, repoId: 1234, repo: "the-approver/app", issue: 7, defaultBranch: "main" };
const KEY = "1234#7";
const BRANCH = "agent/7-add-parser";
const PR = { number: 12, nodeId: "PR_own" };
const log = () => env.DELIVERY_LOG.getByName("global");

type Calls = ReturnType<typeof stubGitHub>;

const revocations = (calls: Calls) =>
  calls.filter((c) => c.method === "DELETE" && c.url.endsWith("/installation/token")).length;

/**
 * A webhook-started run ends by releasing the issue and revoking its token. Wait for
 * both, so nothing reaches the network after the GitHub stub goes.
 */
const runEnded = async (calls: Calls, before: number) => {
  await vi.waitFor(async () => {
    expect(await log().activeRun(KEY)).toBeNull();
    expect(revocations(calls)).toBeGreaterThan(before);
  });
};
const edited = (calls: Calls) =>
  calls.filter((c) => c.method === "PATCH").map((c) => (c.body as { body: string }).body);
const posted = (calls: Calls) =>
  calls
    .filter((c) => c.method === "POST" && c.url.endsWith("/comments"))
    .map((c) => ({ path: new URL(c.url).pathname, body: (c.body as { body: string }).body }));

/** A run that's started and holds the issue, driven by the test. */
async function running(options: FakeOptions = {}, extra: Record<string, unknown> = {}) {
  const runId = crypto.randomUUID();
  const stub = env.RUN_STATE.getByName(runId);
  const fake = fakeContainer(options);
  await runInDurableObject(stub, async (_instance: RunState, state) => {
    await state.storage.put({
      scope: { ...SCOPE, runId },
      runner: "claude-code",
      phase: "starting",
      deadline: Date.now() + 600_000,
      runNumber: 1,
      ...extra,
    });
  });
  expect(await log().claimIssue(KEY, runId)).toBe(true);
  const tick = () =>
    runInDurableObject(stub, async (instance: RunState) => {
      (instance as unknown as { container: () => unknown }).container = () => fake.container;
      await instance.alarm();
    });
  return { runId, stub, fake, tick };
}

function comment(body: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    action: "created",
    comment: { body },
    sender: { login: "the-approver", type: "User" },
    repository: { full_name: "the-approver/app", id: 1234, default_branch: "main" },
    issue: { number: PR.number, state: "open", pull_request: {} },
    installation: { id: 99 },
    ...overrides,
  };
}

/** Leaves the issue blocked by an agent that added agent:blocked and exited. */
async function blockedRun(calls: Calls, runNumber = 1) {
  const run = await running({ files: { "/workspace/task/result.json": '{"type":"result","num_turns":3}' } }, { runNumber });
  await run.stub.pinBranch(`refs/heads/${BRANCH}`);
  await run.stub.pinPullRequest(PR.number, PR.nodeId);
  await run.stub.markBlocked();
  await run.tick();
  await run.tick();
  await run.tick();
  return { ...run, calls };
}

describe("stop", () => {
  it("ends network access at once when the approver adds agent:stop mid-run", async () => {
    const calls = stubGitHub();
    const { runId, stub, fake, tick } = await running({ exit: null });
    await stub.pinPullRequest(PR.number, PR.nodeId);
    await tick();
    await tick();
    expect(fake.state.running).toBe(true);

    const response = await deliver(release({ label: { name: "agent:stop" } }));
    expect(response.status).toBe(202);
    expect(await response.json()).toMatchObject({ run: runId });

    const before = calls.length;
    const request = new Request(`https://api.github.com/repos/${SCOPE.repo}/issues/7`);
    const denied = await handleOutbound(request, { ...SCOPE, runId }, env);
    expect(denied.status).toBe(403);
    expect(await denied.text()).toContain("stopped");
    expect(calls.length).toBe(before);

    expect(edited(calls).at(-1)).toContain("Stopped by the-approver");
    expect(posted(calls).at(-1)).toEqual({
      path: "/repos/the-approver/app/issues/12/comments",
      body: `Run \`${runId}\` was stopped by the-approver. Log: \`/api/runs/${runId}/log\` on the operator console.`,
    });
    expect(await log().activeRun(KEY)).toBeNull();
    expect(calls.filter((c) => c.method === "DELETE" && c.url.endsWith("/installation/token")).length).toBeGreaterThan(0);
  });

  it("stops when the approver removes agent:ready", async () => {
    stubGitHub();
    const { runId } = await running({ exit: null });
    const response = await deliver(release({ action: "unlabeled", label: { name: "agent:ready" } }));
    expect(await response.json()).toMatchObject({ run: runId });
  });

  it("is final: a second stop finds nothing, and removing agent:stop restarts nothing", async () => {
    stubGitHub();
    const { stub } = await running({ exit: null });
    await deliver(release({ label: { name: "agent:stop" } }));
    expect(await stub.halt("again")).toBe(false);
    const again = await deliver(release({ label: { name: "agent:stop" } }));
    expect(await again.json()).toEqual({ ignored: "nothing to stop on this issue" });
    const removed = await deliver(release({ action: "unlabeled", label: { name: "agent:stop" } }));
    expect(await removed.json()).toEqual({ ignored: "another label" });
    expect(await log().activeRun(KEY)).toBeNull();
  });

  it("ignores agent:stop from anyone but the approver", async () => {
    stubGitHub();
    const { stub } = await running({ exit: null });
    for (const sender of [
      { login: "someone-else", type: "User" },
      { login: "danjamk-build-agent[bot]", type: "Bot" },
    ]) {
      const response = await deliver(release({ label: { name: "agent:stop" }, sender }));
      expect(await response.json()).toHaveProperty("ignored");
    }
    expect(await stub.admit()).toMatchObject({ admitted: true });
    await stub.halt("cleanup");
  });

  it("clears a blocked issue, so a later reply doesn't resume it", async () => {
    const calls = stubGitHub();
    await blockedRun(calls);
    const response = await deliver(release({ label: { name: "agent:stop" } }));
    expect(await response.json()).toMatchObject({ cleared: true });
    const reply = await deliver(comment("Go ahead"), { event: "issue_comment" });
    expect(await reply.json()).toEqual({ ignored: "no blocked run to resume" });
  });
});

describe("blocked", () => {
  it("records a block that got through the policy, and says how to resume", async () => {
    const calls = stubGitHub();
    await blockedRun(calls);
    const body = edited(calls).at(-1) ?? "";
    expect(body).toContain("Blocked: the agent is waiting for a reply.");
    expect(body).toContain("Reply on this issue or on PR #12 to resume. This was run 1 of 3.");
    expect(await log().findBlocked(1234, PR.number)).toBe(KEY);
    expect(await log().findBlocked(1234, 7)).toBe(KEY);
    expect(await log().activeRun(KEY)).toBeNull();
    await log().clearBlocked(KEY);
  });

  it("saves a resume point even when the agent blocked before pushing", async () => {
    const calls = stubGitHub();
    const run = await running({ files: { "/workspace/task/result.json": '{"type":"result","num_turns":2}' } });
    await run.stub.markBlocked();
    await run.tick();
    await run.tick();
    await run.tick();
    expect(edited(calls).at(-1)).toContain("Reply on this issue to resume. This was run 1 of 3.");
    expect(await log().findBlocked(1234, 7)).toBe(KEY);

    const before = revocations(calls);
    const delivery = crypto.randomUUID();
    const response = await deliver(comment("Go", { issue: { number: 7, state: "open" } }), { event: "issue_comment", delivery });
    expect(await response.json()).toMatchObject({ run: 2 });
    await runInDurableObject(env.RUN_STATE.getByName(delivery), async (_instance: RunState, state) => {
      expect(await state.storage.get("resume")).toEqual({ branch: null, pr: null, reply: "Go" });
      expect(await state.storage.get("branch")).toBeUndefined();
    });
    await runEnded(calls, before);
  });

  it("treats the time limit as blocked, and adds agent:blocked itself", async () => {
    const calls = stubGitHub();
    const { stub, fake, tick } = await running({ exit: null }, { deadline: Date.now() - 1 });
    await stub.pinBranch(`refs/heads/${BRANCH}`);
    fake.state.running = true;
    await tick();
    expect(fake.state.destroyed).toBe(1);
    expect(edited(calls).at(-1)).toContain("60-minute limit. Work it didn't push is lost.");
    const label = calls.find((c) => c.method === "POST" && c.url.endsWith("/issues/7/labels"));
    expect(label?.body).toEqual({ labels: ["agent:blocked"] });
    expect(await log().findBlocked(1234, 7)).toBe(KEY);
    await log().clearBlocked(KEY);
  });

  it("doesn't offer a resume after the last run", async () => {
    const calls = stubGitHub();
    await blockedRun(calls, 3);
    expect(edited(calls).at(-1)).toContain("This was run 3 of 3, so a reply won't resume it.");
    expect(await log().findBlocked(1234, 7)).toBeNull();
  });

  it("isn't recorded for a run that finished", async () => {
    const calls = stubGitHub();
    const { tick } = await running({ files: { "/workspace/task/result.json": '{"type":"result","num_turns":3}' } });
    await tick();
    await tick();
    await tick();
    expect(edited(calls).at(-1)).toContain("The agent finished");
    expect(await log().findBlocked(1234, 7)).toBeNull();
  });
});

describe("resume", () => {
  it("starts a fresh run from the branch and PR on the approver's reply", async () => {
    const calls = stubGitHub();
    await blockedRun(calls);
    const delivery = crypto.randomUUID();
    const before = revocations(calls);
    const response = await deliver(comment("Use the second option."), { event: "issue_comment", delivery });
    expect(response.status).toBe(202);
    expect(await response.json()).toEqual({ resumed: "the-approver/app#7", run: 2, started: true });
    await runInDurableObject(env.RUN_STATE.getByName(delivery), async (_instance: RunState, state) => {
      expect(await state.storage.get("resume")).toEqual({ branch: BRANCH, pr: PR.number, reply: "Use the second option." });
      expect(await state.storage.get("branch")).toBe(`refs/heads/${BRANCH}`);
      expect(await state.storage.get("pr")).toEqual(PR);
      expect(await state.storage.get("runNumber")).toBe(2);
    });
    // Its own alarm runs with no container in tests and reports that. Let it finish.
    await runEnded(calls, before);
  });

  it("gives a resumed run the reply and the branch, and clears agent:blocked", async () => {
    const calls = stubGitHub();
    const { fake, tick, stub } = await running(
      { exit: null },
      {
        runNumber: 2,
        resume: { branch: BRANCH, pr: PR.number, reply: "Use the second option." },
        branch: `refs/heads/${BRANCH}`,
        pr: PR,
      },
    );
    await tick();
    await tick();
    expect(fake.state.written["/workspace/task/reply.md"]).toBe("Use the second option.\n");
    expect(fake.state.commands[0]?.env).toMatchObject({ RESUMED: "1", RESUME_BRANCH: BRANCH, RESUME_PR: "12" });
    expect(calls.some((c) => c.method === "DELETE" && c.url.includes("/labels/agent%3Ablocked"))).toBe(true);
    await stub.halt("cleanup");
  });

  it("also resumes on a reply on the issue itself", async () => {
    const calls = stubGitHub();
    await blockedRun(calls);
    const before = revocations(calls);
    const response = await deliver(comment("Go", { issue: { number: 7, state: "open" } }), { event: "issue_comment" });
    expect(await response.json()).toMatchObject({ run: 2 });
    await runEnded(calls, before);
  });

  it.each([
    ["another login", { sender: { login: "someone-else", type: "User" } }],
    ["the agent App", { sender: { login: "danjamk-build-agent[bot]", type: "Bot" } }],
    ["a bot with the approver's login", { sender: { login: "the-approver", type: "Bot" } }],
  ])("doesn't resume on a comment from %s", async (_name, overrides) => {
    const calls = stubGitHub();
    await blockedRun(calls);
    const response = await deliver(comment("Go", overrides), { event: "issue_comment" });
    expect(await response.json()).toHaveProperty("ignored");
    expect(await log().findBlocked(1234, PR.number)).toBe(KEY);
    await log().clearBlocked(KEY);
  });

  it("doesn't resume when agent:blocked is removed, even by the approver", async () => {
    const calls = stubGitHub();
    await blockedRun(calls);
    const response = await deliver(release({ action: "unlabeled", label: { name: "agent:blocked" } }));
    expect(await response.json()).toEqual({ ignored: "another label" });
    expect(await log().findBlocked(1234, PR.number)).toBe(KEY);
    await log().clearBlocked(KEY);
  });

  it("resumes once for two replies", async () => {
    const calls = stubGitHub();
    await blockedRun(calls);
    const before = revocations(calls);
    const first = await deliver(comment("Go"), { event: "issue_comment" });
    const second = await deliver(comment("Go again"), { event: "issue_comment" });
    expect(await first.json()).toMatchObject({ run: 2 });
    expect(["no blocked run to resume", "a run is already active on this issue"]).toContain(
      ((await second.json()) as { ignored?: string }).ignored,
    );
    await runEnded(calls, before);
  });

  it("is cleared by a new release", async () => {
    const calls = stubGitHub();
    await blockedRun(calls);
    const before = revocations(calls);
    const response = await deliver(release());
    expect(response.status).toBe(202);
    expect(await log().findBlocked(1234, PR.number)).toBeNull();
    await runEnded(calls, before);
  });
});
