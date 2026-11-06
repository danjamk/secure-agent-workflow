import { DurableObject } from "cloudflare:workers";

/** Longer than GitHub keeps a delivery available for redelivery. */
const RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

/** Longer than any run's limit, so only a run that never reached teardown goes stale. */
const ACTIVE_RUN_MS = 2 * 60 * 60 * 1000;

/**
 * Accepted webhook deliveries, so a redelivery doesn't release an issue twice.
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
