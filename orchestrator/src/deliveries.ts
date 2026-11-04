import { DurableObject } from "cloudflare:workers";

/** Longer than GitHub keeps a delivery available for redelivery. */
const RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

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
