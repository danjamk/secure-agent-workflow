/**
 * The coordinator (ADR-005, #13): a queue of released issues, a cap on concurrent
 * runs, a lock per touch area, and dependency gating. Its state lives in
 * DeliveryLog, the one global Durable Object, so every decision about a slot or a
 * lock is made in one place. This module holds the types and starts the runs the
 * queue hands out.
 */

import { runnerFor } from "./agents";
import { commentOnIssue, getBlockers, getBranchHead, getPullState, mintRunToken, revokeToken, setLabel } from "./github";
import type { RunScope } from "./outbound/scope";
import type { ResumeState } from "./run";

/** What the operator approved at release, fixed until they release the issue again. */
export interface Snapshot {
  title: string;
  body: string;
  /** "owner/name#number", lower case, from GitHub's issue dependencies. */
  blockers: string[];
  /** The issue's area:* labels. None locks every area of the repo. */
  areas: string[];
}

export interface QueueEntry {
  /** issueKey: "<repoId>#<number>". */
  issue: string;
  /** The run id it starts as: the delivery id of the release or the reply. */
  run: string;
  kind: "new" | "resume" | "catchup";
  scope: Omit<RunScope, "runId">;
  runner: string;
  resume: ResumeState | null;
  snapshot: Snapshot;
}

export interface Launch {
  entry: QueueEntry;
  generation: number;
}

/** The issue's name for dependency records, which can cross repos. */
export function nameKey(repo: string, issue: number): string {
  return `${repo.toLowerCase()}#${issue}`;
}

/** The cap, from MAX_CONCURRENT_RUNS. Anything but a whole number from 1 is 1. */
export function maxRuns(env: Env): number {
  const value = Number(env.MAX_CONCURRENT_RUNS);
  return Number.isInteger(value) && value >= 1 ? value : 1;
}

/**
 * Hands out every run the queue allows now, and starts each one. A run that fails
 * to start goes back to the front of the queue with its slot and locks released.
 */
export async function pumpQueue(env: Env): Promise<string[]> {
  const log = env.DELIVERY_LOG.getByName("global");
  const launches = await log.pump(maxRuns(env));
  const started: string[] = [];
  for (const { entry, generation } of launches) {
    const scope: RunScope = { ...entry.scope, runId: entry.run };
    try {
      // An entry with no title has no snapshot: a run blocked before the queue
      // existed. Its run reads the issue as it is now.
      const issue = entry.snapshot.title
        ? { title: entry.snapshot.title, body: entry.snapshot.body, snapshot: entry.snapshot }
        : undefined;
      await env.RUN_STATE.getByName(entry.run).launch(scope, entry.runner, entry.resume ?? undefined, issue);
      started.push(entry.run);
      console.log(`Started ${scope.repo}#${scope.issue} as run ${entry.run} (${entry.kind})`);
    } catch (error) {
      console.error(`Starting ${scope.repo}#${scope.issue} failed: ${(error as Error).name}`);
      await log.unlaunch(entry, generation);
    }
  }
  return started;
}

/** What a release needs: the issue, its repo and labels as the approver released it. */
export interface ReleaseTarget {
  repo: string;
  repoId: number;
  defaultBranch: string;
  number: number;
  installationId: number;
  labels: string[];
  title: string;
  body: string;
}

export type Released =
  | { queued: false; reason: string }
  | { queued: true; runner: string; started: boolean; waiting: string | null };

/**
 * Queues a release: snapshots the issue, with its blockers from GitHub's issue
 * dependencies, and starts it if it can start now. Used by the webhook and by the
 * reconciler for a release it missed (#110).
 */
export async function queueRelease(target: ReleaseTarget, runId: string, env: Env): Promise<Released> {
  const log = env.DELIVERY_LOG.getByName("global");
  const issue = `${target.repoId}#${target.number}`;
  const refused = await log.refusal(issue);
  if (refused) {
    await log.markReleased(issue);
    return { queued: false, reason: refused };
  }
  const runner = runnerFor(target.labels);
  // A token for this one call, revoked straight after.
  const token = await mintRunToken(env, target.installationId, target.repoId);
  let blockers: string[];
  try {
    blockers = await getBlockers(token.value, target.repo, target.number);
  } finally {
    await revokeToken(token.value);
  }
  const entry: QueueEntry = {
    issue,
    run: runId,
    kind: "new",
    scope: {
      installationId: target.installationId,
      repoId: target.repoId,
      repo: target.repo,
      issue: target.number,
      defaultBranch: target.defaultBranch,
    },
    runner: runner.name,
    resume: null,
    snapshot: {
      title: target.title,
      body: target.body,
      blockers,
      areas: target.labels.filter((label) => label.startsWith("area:")),
    },
  };
  const queued = await log.enqueue(entry);
  if (!queued.queued) {
    await log.markReleased(issue);
    return queued;
  }
  // A new release starts over, so an older blocked run can't be resumed after it, and
  // the issue's model budget is whole again.
  await log.clearBlocked(issue);
  await log.clearIssueSpend(issue);
  const started = (await pumpQueue(env)).includes(runId);
  const waiting = started ? null : ((await log.queueState()).find((row) => row.issue === issue)?.waiting ?? null);
  return { queued: true, runner: runner.name, started, waiting };
}

/** A repo the coordinator knows, as the conflict check needs it. */
export interface KnownRepo {
  name: string;
  repoId: number;
  defaultBranch: string;
  installationId: number;
}

/**
 * Queues a catch-up run for each open PR a run opened that now conflicts with the
 * default branch: one per default branch commit, two in all. After that, the
 * issue is marked agent:blocked and the PR says why (#111, ADR-005). Returns the
 * PRs it queued catch-ups for.
 */
export async function queueCatchUps(env: Env, repo: KnownRepo, token: string): Promise<number[]> {
  const log = env.DELIVERY_LOG.getByName("global");
  const recorded = await log.recordedPullRequests(repo.repoId);
  if (!recorded.length) return [];
  const base = await getBranchHead(token, repo.name, repo.defaultBranch);
  const queued: number[] = [];
  for (const { pr, issue } of recorded) {
    let state;
    try {
      state = await getPullState(token, repo.name, pr);
    } catch (error) {
      // One PR that can't be read doesn't stop the others. The next check tries again.
      console.error(`Reading ${repo.name}#${pr} for a catch-up failed: ${(error as Error).message}`);
      continue;
    }
    if (state.closed || state.mergeableState !== "dirty" || state.base !== repo.defaultBranch || !state.head) continue;
    // An issue with a run active or queued gets checked again next time.
    if (await log.refusal(issue)) continue;
    const number = Number(issue.split("#")[1]);
    const decision = await log.catchUp(repo.repoId, pr, base);
    if (decision === "run") {
      const entry: QueueEntry = {
        issue,
        run: crypto.randomUUID(),
        kind: "catchup",
        scope: {
          installationId: repo.installationId,
          repoId: repo.repoId,
          repo: repo.name,
          issue: number,
          defaultBranch: repo.defaultBranch,
        },
        runner: "claude-code",
        // A catch-up doesn't use up one of the release's runs.
        resume: { branch: state.head, pr: { number: pr, nodeId: state.nodeId }, reply: "", runNumber: 1, catchup: true },
        // It runs inside the areas its issue already holds.
        snapshot: { title: "", body: "", blockers: [], areas: await log.areasHeld(issue) },
      };
      if ((await log.enqueue(entry)).queued) queued.push(pr);
    } else if (decision === "give up") {
      await setLabel(token, repo.name, number, "agent:blocked", true);
      await commentOnIssue(
        token,
        repo.name,
        pr,
        `This PR still conflicts with \`${repo.defaultBranch}\` after two catch-up runs, so it's handed to the approver: merge \`${repo.defaultBranch}\` into it by hand, or close it.`,
      );
    }
  }
  return queued;
}
