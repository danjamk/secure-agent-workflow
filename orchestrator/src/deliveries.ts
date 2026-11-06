import { DurableObject } from "cloudflare:workers";
import type { Tokens } from "./outbound/spend";

/** Longer than GitHub keeps a delivery available for redelivery. */
const RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

/** Longer than any run's limit, so only a run that never reached teardown goes stale. */
const ACTIVE_RUN_MS = 2 * 60 * 60 * 1000;

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
