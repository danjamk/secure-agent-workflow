import { DurableObject } from "cloudflare:workers";
import { mintRunToken, revokeToken, type RunToken } from "./github";
import type { Pins, RunScope } from "./outbound/scope";

/** Installation tokens last an hour. Replace one before a long push could outlive it. */
const REFRESH_MS = 10 * 60 * 1000;

export type Admission = ({ admitted: true } & Pins) | { admitted: false; reason: string };

/**
 * One run's mutable state, outside the container: the stop flag, the branch and PR
 * it's pinned to, and its token. The token is held in memory only, so it never
 * reaches storage. If the object is evicted, the next request mints another.
 */
export class RunState extends DurableObject<Env> {
  private token: RunToken | null = null;
  private minting: Promise<RunToken> | null = null;

  async begin(scope: RunScope): Promise<void> {
    await this.ctx.storage.put("scope", scope);
  }

  async admit(): Promise<Admission> {
    if (!(await this.ctx.storage.get<RunScope>("scope"))) {
      return { admitted: false, reason: "the run isn't active" };
    }
    if (await this.ctx.storage.get<boolean>("stopped")) {
      return { admitted: false, reason: "the run is stopped" };
    }
    return {
      admitted: true,
      branch: (await this.ctx.storage.get<string>("branch")) ?? null,
      pr: (await this.ctx.storage.get<Pins["pr"]>("pr")) ?? null,
    };
  }

  /** True if this is the run's branch. The first ref pushed becomes it. */
  async pinBranch(ref: string): Promise<boolean> {
    const pinned = await this.ctx.storage.get<string>("branch");
    if (pinned) return pinned === ref;
    await this.ctx.storage.put("branch", ref);
    return true;
  }

  async pinPullRequest(number: number, nodeId: string): Promise<void> {
    await this.ctx.storage.put("pr", { number, nodeId });
  }

  async stop(): Promise<void> {
    await this.ctx.storage.put("stopped", true);
    const token = this.token;
    this.token = null;
    if (token) await revokeToken(token.value);
  }

  async accessToken(): Promise<string> {
    if (this.token && this.token.expiresAt - Date.now() > REFRESH_MS) return this.token.value;
    // Requests arrive concurrently, and one mint serves them all.
    this.minting ??= this.mint().finally(() => {
      this.minting = null;
    });
    return (await this.minting).value;
  }

  private async mint(): Promise<RunToken> {
    const scope = await this.ctx.storage.get<RunScope>("scope");
    if (!scope) throw new Error("The run isn't active");
    if (await this.ctx.storage.get<boolean>("stopped")) throw new Error("The run is stopped");
    const token = await mintRunToken(this.env, scope.installationId, scope.repoId);
    // A stop can arrive during the mint, when there was no token yet to revoke.
    if (await this.ctx.storage.get<boolean>("stopped")) {
      await revokeToken(token.value);
      throw new Error("The run is stopped");
    }
    this.token = token;
    return token;
  }
}
