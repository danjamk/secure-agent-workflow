import { DurableObject } from "cloudflare:workers";
import type { Launch, QueueEntry } from "./coordinator";
import type { Tokens } from "./outbound/spend";

/** Longer than GitHub keeps a delivery available for redelivery. */
const RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

/** Longer than any run's limit, so only a run that never reached teardown goes stale. */
const ACTIVE_RUN_MS = 2 * 60 * 60 * 1000;

/** Catch-ups a PR gets before it's handed to the operator (ADR-005). */
const MAX_CATCH_UPS = 2;

/** The areas a queue entry locks: its area labels, or every area if it has none. */
function areasOf(entry: QueueEntry): string[] {
  return entry.snapshot.areas.length ? entry.snapshot.areas : ["*"];
}

function monthKey(now: number): string {
  return `month:${new Date(now).toISOString().slice(0, 7)}`;
}

export interface Reservation {
  id: string;
  run: string;
  issue: string;
  amount: number;
  limits: { run: number; issue: number; month: number };
}

export type Admitted = { reserved: true } | { reserved: false; budget: "run" | "issue" | "month"; limit: number };

export interface RunUsage {
  calls: number;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cost: number;
}

/**
 * Accepted webhook deliveries, so a redelivery doesn't release an issue twice. Also
 * the active run per issue, blocked runs a reply can resume, and the model spend
 * ledger (#92).
 * A Durable Object because the check has to be strongly consistent, which KV
 * isn't. One instance serves the deployment.
 */
export class DeliveryLog extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS deliveries (id TEXT PRIMARY KEY, at INTEGER NOT NULL)",
    );
    ctx.storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS active_runs (issue TEXT PRIMARY KEY, run TEXT NOT NULL, at INTEGER NOT NULL)",
    );
    ctx.storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS blocked (issue TEXT PRIMARY KEY, repo_id INTEGER NOT NULL, pr INTEGER, record TEXT NOT NULL, at INTEGER NOT NULL)",
    );
    // Model spend (#92), in micro-dollars. `spend` holds settled amounts by key
    // (run:<id>, issue:<key>, month:<YYYY-MM>); `reservations` holds calls in flight.
    ctx.storage.sql.exec("CREATE TABLE IF NOT EXISTS spend (key TEXT PRIMARY KEY, settled INTEGER NOT NULL)");
    ctx.storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS reservations (id TEXT PRIMARY KEY, run TEXT NOT NULL, issue TEXT NOT NULL, month TEXT NOT NULL, amount INTEGER NOT NULL, at INTEGER NOT NULL)",
    );
    // The coordinator (ADR-005, #13). `queue` holds released issues waiting for a
    // slot; `generations` counts releases, so a stop invalidates a queued entry;
    // `area_locks` holds each repo's touch areas ('*' for all of them);
    // `issue_prs` maps a run's PR to its issue; `completed` holds issues that count
    // as done for dependency gating.
    ctx.storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS queue (issue TEXT PRIMARY KEY, kind TEXT NOT NULL, generation INTEGER NOT NULL, entry TEXT NOT NULL, entered INTEGER NOT NULL, waiting TEXT)",
    );
    ctx.storage.sql.exec("CREATE TABLE IF NOT EXISTS generations (issue TEXT PRIMARY KEY, generation INTEGER NOT NULL)");
    ctx.storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS area_locks (repo_id INTEGER NOT NULL, area TEXT NOT NULL, issue TEXT NOT NULL, PRIMARY KEY (repo_id, area))",
    );
    ctx.storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS issue_prs (repo_id INTEGER NOT NULL, pr INTEGER NOT NULL, issue TEXT NOT NULL, name TEXT NOT NULL, PRIMARY KEY (repo_id, pr))",
    );
    ctx.storage.sql.exec("CREATE TABLE IF NOT EXISTS completed (name TEXT PRIMARY KEY, how TEXT NOT NULL, at INTEGER NOT NULL)");
    // For reconciling against GitHub (#110): each repo a webhook came from, and when
    // each issue was last released, so a label already acted on isn't acted on again.
    ctx.storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS repos (repo_id INTEGER PRIMARY KEY, name TEXT NOT NULL, installation_id INTEGER NOT NULL, default_branch TEXT NOT NULL, first_seen INTEGER)",
    );
    // When the coordinator first heard from the repo. The reconciler ignores labels
    // from before then. Repos recorded before this column get the time it was added.
    try {
      ctx.storage.sql.exec("ALTER TABLE repos ADD COLUMN first_seen INTEGER");
    } catch {
      // The column exists.
    }
    ctx.storage.sql.exec("UPDATE repos SET first_seen = ? WHERE first_seen IS NULL", Date.now());
    ctx.storage.sql.exec("CREATE TABLE IF NOT EXISTS released (issue TEXT PRIMARY KEY, at INTEGER NOT NULL)");
    // Catch-up runs (#111): the default branch commit each PR's last catch-up ran
    // against, and how many it has had.
    ctx.storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS catchups (repo_id INTEGER NOT NULL, pr INTEGER NOT NULL, base TEXT NOT NULL, count INTEGER NOT NULL, PRIMARY KEY (repo_id, pr))",
    );
    ctx.storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS run_usage (run TEXT PRIMARY KEY, calls INTEGER NOT NULL, input INTEGER NOT NULL, output INTEGER NOT NULL, cache_read INTEGER NOT NULL, cache_write INTEGER NOT NULL, cost INTEGER NOT NULL)",
    );
  }

  /** Settled spend plus what's reserved by calls in flight. */
  private used(key: string): number {
    const sql = this.ctx.storage.sql;
    const settled = sql.exec<{ settled: number }>("SELECT settled FROM spend WHERE key = ?", key).toArray()[0];
    const held = sql
      .exec<{ held: number }>(
        "SELECT COALESCE(SUM(amount), 0) AS held FROM reservations WHERE run = ? OR issue = ? OR month = ?",
        key,
        key,
        key,
      )
      .toArray()[0];
    return (settled?.settled ?? 0) + (held?.held ?? 0);
  }

  private add(key: string, amount: number): void {
    this.ctx.storage.sql.exec(
      "INSERT INTO spend (key, settled) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET settled = settled + excluded.settled",
      key,
      amount,
    );
  }

  /** The month's spend so far, including calls in flight. */
  monthUsed(now = Date.now()): number {
    return this.used(monthKey(now));
  }

  /**
   * Holds a call's worst-case cost, if the run, the issue and the month all have room
   * for it. One object serves the deployment, so two calls can't both take the last
   * of a budget.
   */
  reserve(call: Reservation): Admitted {
    const keys = { run: `run:${call.run}`, issue: `issue:${call.issue}`, month: monthKey(Date.now()) };
    for (const budget of ["run", "issue", "month"] as const) {
      if (this.used(keys[budget]) + call.amount > call.limits[budget]) {
        return { reserved: false, budget, limit: call.limits[budget] };
      }
    }
    this.ctx.storage.sql.exec(
      "INSERT INTO reservations (id, run, issue, month, amount, at) VALUES (?, ?, ?, ?, ?, ?)",
      call.id,
      keys.run,
      keys.issue,
      keys.month,
      call.amount,
      Date.now(),
    );
    return { reserved: true };
  }

  /**
   * Replaces a reservation with what the call cost. With no usage, the billing is
   * unknown and the whole reservation is kept.
   */
  settle(id: string, usage: { tokens: Tokens; cost: number } | null): void {
    const sql = this.ctx.storage.sql;
    const row = sql
      .exec<{ run: string; issue: string; month: string; amount: number }>(
        "SELECT run, issue, month, amount FROM reservations WHERE id = ?",
        id,
      )
      .toArray()[0];
    if (!row) return;
    sql.exec("DELETE FROM reservations WHERE id = ?", id);
    const cost = usage ? usage.cost : row.amount;
    for (const key of [row.run, row.issue, row.month]) this.add(key, cost);
    const tokens = usage?.tokens;
    sql.exec(
      `INSERT INTO run_usage (run, calls, input, output, cache_read, cache_write, cost) VALUES (?, 1, ?, ?, ?, ?, ?)
       ON CONFLICT(run) DO UPDATE SET calls = calls + 1, input = input + excluded.input, output = output + excluded.output,
       cache_read = cache_read + excluded.cache_read, cache_write = cache_write + excluded.cache_write, cost = cost + excluded.cost`,
      row.run.slice("run:".length),
      tokens?.input ?? 0,
      tokens?.output ?? 0,
      tokens?.cacheRead ?? 0,
      (tokens?.cacheWrite5m ?? 0) + (tokens?.cacheWrite1h ?? 0),
      cost,
    );
  }

  /** A run's model use, for its status comment. Null if it made no charged call. */
  runUsage(run: string): RunUsage | null {
    const row = this.ctx.storage.sql
      .exec<{ calls: number; input: number; output: number; cache_read: number; cache_write: number; cost: number }>(
        "SELECT calls, input, output, cache_read, cache_write, cost FROM run_usage WHERE run = ?",
        run,
      )
      .toArray()[0];
    if (!row) return null;
    return {
      calls: row.calls,
      input: row.input,
      output: row.output,
      cacheRead: row.cache_read,
      cacheWrite: row.cache_write,
      cost: row.cost,
    };
  }

  /** A new release starts the issue's budget over. Its runs' spend still counts for the month. */
  clearIssueSpend(issue: string): void {
    this.ctx.storage.sql.exec("DELETE FROM spend WHERE key = ?", `issue:${issue}`);
  }

  /**
   * Adds a released or resumed issue to the queue. Refused while the issue is
   * queued or has an active run, so relabeling can't start a second.
   */
  enqueue(entry: QueueEntry): { queued: true; generation: number } | { queued: false; reason: string } {
    const sql = this.ctx.storage.sql;
    const refused = this.refusal(entry.issue);
    if (refused) return { queued: false, reason: refused };
    const generation = this.nextGeneration(entry.issue);
    if (entry.kind === "new") {
      sql.exec("INSERT OR REPLACE INTO released (issue, at) VALUES (?, ?)", entry.issue, Date.now());
    }
    sql.exec(
      "INSERT INTO queue (issue, kind, generation, entry, entered, waiting) VALUES (?, ?, ?, ?, ?, NULL)",
      entry.issue,
      entry.kind,
      generation,
      JSON.stringify(entry),
      Date.now(),
    );
    return { queued: true, generation };
  }

  /** Why a release would be refused now, so the webhook can skip reading blockers. */
  refusal(issue: string): string | null {
    if (this.ctx.storage.sql.exec("SELECT 1 FROM queue WHERE issue = ?", issue).toArray().length) {
      return "the issue is already queued";
    }
    return this.activeRun(issue) ? "a run is already active on this issue" : null;
  }

  private nextGeneration(issue: string): number {
    const row = this.ctx.storage.sql
      .exec<{ generation: number }>(
        "INSERT INTO generations (issue, generation) VALUES (?, 1) ON CONFLICT(issue) DO UPDATE SET generation = generation + 1 RETURNING generation",
        issue,
      )
      .toArray()[0];
    return row?.generation ?? 1;
  }

  /** Takes an issue out of the queue on a stop, and frees its areas. True if it was queued. */
  dequeue(issue: string): boolean {
    const sql = this.ctx.storage.sql;
    const removed = sql.exec("DELETE FROM queue WHERE issue = ?", issue).rowsWritten > 0;
    // A stop also invalidates any entry an older delivery might still add.
    this.nextGeneration(issue);
    this.releaseAreas(issue);
    return removed;
  }

  /**
   * Hands out every queued issue that may start now, oldest first with resumes
   * ahead, and reserves its slot and areas. One that can't start is skipped, not a
   * barrier, and keeps the reason it's waiting.
   */
  pump(maxRuns: number, now = Date.now()): Launch[] {
    const sql = this.ctx.storage.sql;
    sql.exec("DELETE FROM active_runs WHERE at < ?", now - ACTIVE_RUN_MS);
    const rows = sql
      .exec<{ issue: string; generation: number; entry: string }>(
        "SELECT issue, generation, entry FROM queue ORDER BY kind != 'new' DESC, entered, issue",
      )
      .toArray();
    let running = sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM active_runs").toArray()[0]?.n ?? 0;
    const launches: Launch[] = [];
    for (const row of rows) {
      const entry = JSON.parse(row.entry) as QueueEntry;
      const current = sql
        .exec<{ generation: number }>("SELECT generation FROM generations WHERE issue = ?", row.issue)
        .toArray()[0]?.generation;
      if (current !== row.generation) {
        sql.exec("DELETE FROM queue WHERE issue = ?", row.issue);
        continue;
      }
      const reason = running >= maxRuns ? "no free slot" : this.blockedReason(entry);
      if (reason) {
        sql.exec("UPDATE queue SET waiting = ? WHERE issue = ?", reason, row.issue);
        continue;
      }
      sql.exec("DELETE FROM queue WHERE issue = ?", row.issue);
      sql.exec("INSERT OR REPLACE INTO active_runs (issue, run, at) VALUES (?, ?, ?)", row.issue, entry.run, now);
      for (const area of areasOf(entry)) {
        sql.exec("INSERT OR REPLACE INTO area_locks (repo_id, area, issue) VALUES (?, ?, ?)", entry.scope.repoId, area, row.issue);
      }
      running += 1;
      launches.push({ entry, generation: row.generation });
    }
    return launches;
  }

  /** Why an issue can't start, apart from slots, or null if it can. */
  private blockedReason(entry: QueueEntry): string | null {
    const sql = this.ctx.storage.sql;
    for (const blocker of entry.snapshot.blockers) {
      if (!sql.exec("SELECT 1 FROM completed WHERE name = ?", blocker).toArray().length) return `blocked by ${blocker}`;
    }
    const held = sql
      .exec<{ area: string; issue: string }>("SELECT area, issue FROM area_locks WHERE repo_id = ? AND issue != ?", entry.scope.repoId, entry.issue)
      .toArray();
    const wanted = areasOf(entry);
    for (const lock of held) {
      if (lock.area === "*" || wanted.includes("*") || wanted.includes(lock.area)) {
        return lock.area === "*" ? `the repo is locked by ${lock.issue}` : `${lock.area} is held by ${lock.issue}`;
      }
    }
    return null;
  }

  /** A run that failed to start goes back to the front of the queue. */
  unlaunch(entry: QueueEntry, generation: number): void {
    const sql = this.ctx.storage.sql;
    sql.exec("DELETE FROM active_runs WHERE issue = ? AND run = ?", entry.issue, entry.run);
    this.releaseAreas(entry.issue);
    sql.exec(
      "INSERT OR IGNORE INTO queue (issue, kind, generation, entry, entered, waiting) VALUES (?, ?, ?, ?, 0, 'the last start failed')",
      entry.issue,
      entry.kind,
      generation,
      JSON.stringify(entry),
    );
  }

  /**
   * A run ended: its slot is free. Its areas stay locked while its PR is open or
   * it's blocked waiting for the operator, and are freed otherwise.
   */
  runEnded(issue: string, run: string, keepAreas: boolean): void {
    this.releaseIssue(issue, run);
    if (!keepAreas) this.releaseAreas(issue);
  }

  releaseAreas(issue: string): void {
    this.ctx.storage.sql.exec("DELETE FROM area_locks WHERE issue = ?", issue);
  }

  /** The PR a run opened, so its merge can complete the issue and free its areas. */
  recordPullRequest(issue: string, name: string, repoId: number, pr: number): void {
    this.ctx.storage.sql.exec(
      "INSERT OR REPLACE INTO issue_prs (repo_id, pr, issue, name) VALUES (?, ?, ?, ?)",
      repoId,
      pr,
      issue,
      name,
    );
  }

  /**
   * A PR closed. If it's a run's PR, the issue's areas are freed, and a merge into
   * the default branch completes the issue. Returns the issue, or null for a PR no
   * run opened.
   */
  pullRequestClosed(repoId: number, pr: number, mergedIntoDefault: boolean): string | null {
    const row = this.ctx.storage.sql
      .exec<{ issue: string; name: string }>("SELECT issue, name FROM issue_prs WHERE repo_id = ? AND pr = ?", repoId, pr)
      .toArray()[0];
    if (!row) return null;
    this.releaseAreas(row.issue);
    if (mergedIntoDefault) this.markCompleted(row.name, `PR #${pr} merged`);
    // A closed PR needs no more catch-ups.
    this.ctx.storage.sql.exec("DELETE FROM issue_prs WHERE repo_id = ? AND pr = ?", repoId, pr);
    this.ctx.storage.sql.exec("DELETE FROM catchups WHERE repo_id = ? AND pr = ?", repoId, pr);
    return row.issue;
  }

  /** The open PRs runs opened in a repo, with their issues. */
  recordedPullRequests(repoId: number): { pr: number; issue: string; name: string }[] {
    return this.ctx.storage.sql
      .exec<{ pr: number; issue: string; name: string }>("SELECT pr, issue, name FROM issue_prs WHERE repo_id = ? ORDER BY pr", repoId)
      .toArray();
  }

  /**
   * Whether a conflicting PR gets a catch-up against this default branch commit:
   * one per commit, two in all, then it's handed to the operator once (#111).
   */
  catchUp(repoId: number, pr: number, base: string): "run" | "already" | "give up" | "given up" {
    const sql = this.ctx.storage.sql;
    const row = sql.exec<{ base: string; count: number }>("SELECT base, count FROM catchups WHERE repo_id = ? AND pr = ?", repoId, pr).toArray()[0];
    if (row?.base === base) return "already";
    if ((row?.count ?? 0) > MAX_CATCH_UPS) return "given up";
    if ((row?.count ?? 0) === MAX_CATCH_UPS) {
      sql.exec("UPDATE catchups SET count = count + 1, base = ? WHERE repo_id = ? AND pr = ?", base, repoId, pr);
      return "give up";
    }
    sql.exec(
      "INSERT INTO catchups (repo_id, pr, base, count) VALUES (?, ?, ?, 1) ON CONFLICT(repo_id, pr) DO UPDATE SET base = excluded.base, count = count + 1",
      repoId,
      pr,
      base,
    );
    return "run";
  }

  /** The areas an issue holds now, so its catch-up runs inside them. */
  areasHeld(issue: string): string[] {
    return this.ctx.storage.sql
      .exec<{ area: string }>("SELECT area FROM area_locks WHERE issue = ? ORDER BY area", issue)
      .toArray()
      .map((row) => row.area)
      .filter((area) => area !== "*");
  }

  /** An issue that now counts as done for the issues it blocks. */
  markCompleted(name: string, how: string): void {
    this.ctx.storage.sql.exec("INSERT OR IGNORE INTO completed (name, how, at) VALUES (?, ?, ?)", name, how, Date.now());
  }

  /** A repo a webhook came from, kept up to date, so the reconciler can reach it (#110). */
  recordRepo(repoId: number, name: string, installationId: number, defaultBranch: string, now = Date.now()): void {
    // first_seen is set once, on the first webhook from the repo.
    this.ctx.storage.sql.exec(
      `INSERT INTO repos (repo_id, name, installation_id, default_branch, first_seen) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(repo_id) DO UPDATE SET name = excluded.name, installation_id = excluded.installation_id, default_branch = excluded.default_branch`,
      repoId,
      name,
      installationId,
      defaultBranch,
      now,
    );
  }

  repos(): { repoId: number; name: string; installationId: number; defaultBranch: string; firstSeen: number }[] {
    return this.ctx.storage.sql
      .exec<{ repo_id: number; name: string; installation_id: number; default_branch: string; first_seen: number | null }>(
        "SELECT repo_id, name, installation_id, default_branch, first_seen FROM repos ORDER BY repo_id",
      )
      .toArray()
      .map((row) => ({
        repoId: row.repo_id,
        name: row.name,
        installationId: row.installation_id,
        defaultBranch: row.default_branch,
        firstSeen: row.first_seen ?? Date.now(),
      }));
  }

  /**
   * Records that a release was handled, even one refused because the issue was
   * queued or running, so the reconciler doesn't act on that label later.
   */
  markReleased(issue: string): void {
    this.ctx.storage.sql.exec("INSERT OR REPLACE INTO released (issue, at) VALUES (?, ?)", issue, Date.now());
  }

  /** When the issue was last released, or null if never. */
  releasedAt(issue: string): number | null {
    return this.ctx.storage.sql.exec<{ at: number }>("SELECT at FROM released WHERE issue = ?", issue).toArray()[0]?.at ?? null;
  }

  /** True if the issue has a blocked run waiting for a reply. */
  isBlocked(issue: string): boolean {
    return this.ctx.storage.sql.exec("SELECT 1 FROM blocked WHERE issue = ?", issue).toArray().length > 0;
  }

  /** Each locked issue in a repo, with the PRs its runs opened. */
  lockedIssues(repoId: number): { issue: string; prs: number[] }[] {
    const sql = this.ctx.storage.sql;
    return sql
      .exec<{ issue: string }>("SELECT DISTINCT issue FROM area_locks WHERE repo_id = ? ORDER BY issue", repoId)
      .toArray()
      .map((row) => ({
        issue: row.issue,
        prs: sql
          .exec<{ pr: number }>("SELECT pr FROM issue_prs WHERE repo_id = ? AND issue = ? ORDER BY pr", repoId, row.issue)
          .toArray()
          .map((pr) => pr.pr),
      }));
  }

  /** Blockers of queued issues that aren't done yet, as "owner/name#number". */
  pendingBlockers(): string[] {
    const sql = this.ctx.storage.sql;
    const names = new Set<string>();
    for (const row of sql.exec<{ entry: string }>("SELECT entry FROM queue").toArray()) {
      for (const blocker of (JSON.parse(row.entry) as QueueEntry).snapshot.blockers) {
        if (!sql.exec("SELECT 1 FROM completed WHERE name = ?", blocker).toArray().length) names.add(blocker);
      }
    }
    return [...names].sort();
  }

  /** The active runs, with when each took its slot. */
  activeRuns(): { issue: string; run: string; at: number }[] {
    return this.ctx.storage.sql
      .exec<{ issue: string; run: string; at: number }>("SELECT issue, run, at FROM active_runs ORDER BY at")
      .toArray();
  }

  /** The queue with each issue's reason for waiting, oldest first, for the digest and tests. */
  queueState(): { issue: string; run: string; kind: string; waiting: string | null }[] {
    return this.ctx.storage.sql
      .exec<{ issue: string; kind: string; entry: string; waiting: string | null }>(
        "SELECT issue, kind, entry, waiting FROM queue ORDER BY kind != 'new' DESC, entered, issue",
      )
      .toArray()
      .map((row) => ({ issue: row.issue, run: (JSON.parse(row.entry) as QueueEntry).run, kind: row.kind, waiting: row.waiting }));
  }

  /** The issue's active run, if any. */
  activeRun(issue: string): string | null {
    const row = this.ctx.storage.sql
      .exec<{ run: string }>("SELECT run FROM active_runs WHERE issue = ? AND at >= ?", issue, Date.now() - ACTIVE_RUN_MS)
      .toArray()[0];
    return row?.run ?? null;
  }

  /** Saves what a reply needs to resume a blocked issue. A later block replaces it. */
  markBlocked(issue: string, repoId: number, pr: number | null, record: string): void {
    this.ctx.storage.sql.exec(
      "INSERT OR REPLACE INTO blocked (issue, repo_id, pr, record, at) VALUES (?, ?, ?, ?, ?)",
      issue,
      repoId,
      pr,
      record,
      Date.now(),
    );
  }

  /** The blocked issue a comment on `number` belongs to: the issue itself, or its PR. */
  findBlocked(repoId: number, number: number): string | null {
    const row = this.ctx.storage.sql
      .exec<{ issue: string }>(
        "SELECT issue FROM blocked WHERE issue = ? OR (repo_id = ? AND pr = ?)",
        `${repoId}#${number}`,
        repoId,
        number,
      )
      .toArray()[0];
    return row?.issue ?? null;
  }

  /** Takes the blocked record, so only one reply resumes it. */
  takeBlocked(issue: string): string | null {
    const row = this.ctx.storage.sql
      .exec<{ record: string }>("SELECT record FROM blocked WHERE issue = ?", issue)
      .toArray()[0];
    if (!row) return null;
    this.ctx.storage.sql.exec("DELETE FROM blocked WHERE issue = ?", issue);
    return row.record;
  }

  clearBlocked(issue: string): void {
    this.ctx.storage.sql.exec("DELETE FROM blocked WHERE issue = ?", issue);
  }

  /**
   * True if this run may start on this issue, which holds while another run is
   * active. A claim older than ACTIVE_RUN_MS is stale, from a run that never
   * finished, and is replaced.
   */
  claimIssue(issue: string, run: string): boolean {
    const now = Date.now();
    const sql = this.ctx.storage.sql;
    sql.exec("DELETE FROM active_runs WHERE at < ?", now - ACTIVE_RUN_MS);
    const insert = sql.exec("INSERT OR IGNORE INTO active_runs (issue, run, at) VALUES (?, ?, ?)", issue, run, now);
    return insert.rowsWritten > 0;
  }

  /** Called when a run ends. Only the run that holds the claim can release it. */
  releaseIssue(issue: string, run: string): void {
    this.ctx.storage.sql.exec("DELETE FROM active_runs WHERE issue = ? AND run = ?", issue, run);
  }

  /** True the first time an id is seen, false after that. */
  claim(id: string): boolean {
    const now = Date.now();
    const sql = this.ctx.storage.sql;
    sql.exec("DELETE FROM deliveries WHERE at < ?", now - RETENTION_MS);
    const insert = sql.exec("INSERT OR IGNORE INTO deliveries (id, at) VALUES (?, ?)", id, now);
    return insert.rowsWritten > 0;
  }

  /** Undo a claim whose work failed, so a redelivery can try again. */
  forget(id: string): void {
    this.ctx.storage.sql.exec("DELETE FROM deliveries WHERE id = ?", id);
  }
}
