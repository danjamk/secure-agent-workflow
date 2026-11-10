/**
 * Reconciles the coordinator against GitHub every 5 minutes (#110, ADR-005), so a
 * webhook GitHub failed to deliver delays a run but never loses one. It runs from
 * the Worker's cron trigger.
 *
 * It finds releases, PR closes and blocker closes it missed, and frees slots whose
 * runs ended without telling it. It trusts who did something, from GitHub's own
 * records, never the current presence of a label (design review R5).
 */

import { nameKey, pumpQueue, queueRelease } from "./coordinator";
import { getClosure, getPullState, GitHubError, lastReadyLabel, listReadyIssues, mintRunToken, revokeToken } from "./github";
import { parseRepos } from "./webhook";

/** A slot this new may belong to a run that's still being started. */
const SLOT_GRACE_MS = 2 * 60 * 1000;

export interface Reconciled {
  released: string[];
  prsClosed: string[];
  blockersDone: string[];
  slotsFreed: string[];
  failed: string[];
}

export async function reconcile(env: Env, now = Date.now()): Promise<Reconciled> {
  const log = env.DELIVERY_LOG.getByName("global");
  const result: Reconciled = { released: [], prsClosed: [], blockersDone: [], slotsFreed: [], failed: [] };
  const allowed = parseRepos(env.ALLOWED_REPOS);
  const approver = env.APPROVER_LOGIN.toLowerCase();
  const pending = await log.pendingBlockers();

  for (const repo of await log.repos()) {
    if (!allowed.includes(repo.name.toLowerCase())) continue;
    let token: string;
    try {
      token = (await mintRunToken(env, repo.installationId, repo.repoId)).value;
    } catch (error) {
      result.failed.push(`${repo.name}: ${reason(error)}`);
      continue;
    }
    try {
      // Releases it missed: agent:ready added by the approver after the last release,
      // and after the coordinator first heard from the repo.
      if (approver) {
        for (const issue of await listReadyIssues(token, repo.name)) {
          const key = `${repo.repoId}#${issue.number}`;
          if (issue.labels.includes("agent:stop") || (await log.refusal(key)) || (await log.isBlocked(key))) continue;
          const label = await lastReadyLabel(token, repo.name, issue.number);
          if (!label || label.login.toLowerCase() !== approver || label.type !== "User") continue;
          // A label from before the coordinator heard from the repo, or before the
          // issue's last handled release, has been acted on or predates tracking.
          if (label.at <= Math.max((await log.releasedAt(key)) ?? 0, repo.firstSeen)) continue;
          const released = await queueRelease(
            { ...issue, repo: repo.name, repoId: repo.repoId, defaultBranch: repo.defaultBranch, installationId: repo.installationId },
            crypto.randomUUID(),
            env,
          );
          if (released.queued) result.released.push(`${repo.name}#${issue.number}`);
        }
      }

      // PR closes it missed: each locked issue's recorded PRs.
      for (const locked of await log.lockedIssues(repo.repoId)) {
        for (const pr of locked.prs) {
          const state = await getPullState(token, repo.name, pr);
          if (!state.closed) continue;
          await log.pullRequestClosed(repo.repoId, pr, state.merged && state.base === repo.defaultBranch);
          result.prsClosed.push(`${repo.name}#${pr}`);
        }
      }

      // Blocker closes it missed: closed as completed by the approver.
      if (approver) {
        for (const blocker of pending) {
          const [name, number] = blocker.split("#");
          if (name !== repo.name.toLowerCase() || !number) continue;
          const closure = await getClosure(token, repo.name, Number(number));
          if (closure?.reason !== "completed" || closure.login.toLowerCase() !== approver || closure.type !== "User") continue;
          await log.markCompleted(nameKey(repo.name, Number(number)), "closed by the approver");
          result.blockersDone.push(blocker);
        }
      }
    } catch (error) {
      result.failed.push(`${repo.name}: ${reason(error)}`);
    } finally {
      await revokeToken(token).catch(() => undefined);
    }
  }

  // Slots whose runs ended, or never started, without telling the coordinator. The
  // run's areas stay until its PR is checked.
  for (const active of await log.activeRuns()) {
    if (now - active.at < SLOT_GRACE_MS) continue;
    const status = await env.RUN_STATE.getByName(active.run).status();
    if (status !== null && status !== "done") continue;
    await log.releaseIssue(active.issue, active.run);
    result.slotsFreed.push(active.issue);
  }

  await pumpQueue(env);
  const changed = Object.entries(result).filter(([, list]) => list.length);
  if (changed.length) console.log(JSON.stringify({ reconciled: Object.fromEntries(changed) }));
  return result;
}

/** Safe to log: a GitHubError's message, or only an error's type. */
function reason(error: unknown): string {
  return error instanceof GitHubError ? error.message : (error as Error).name;
}
