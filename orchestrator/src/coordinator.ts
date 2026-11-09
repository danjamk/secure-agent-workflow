/**
 * The coordinator (ADR-005, #13): a queue of released issues, a cap on concurrent
 * runs, a lock per touch area, and dependency gating. Its state lives in
 * DeliveryLog, the one global Durable Object, so every decision about a slot or a
 * lock is made in one place. This module holds the types and starts the runs the
 * queue hands out.
 */

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
  kind: "new" | "resume";
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
