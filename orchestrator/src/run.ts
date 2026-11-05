import { DurableObject } from "cloudflare:workers";
import { commentOnIssue, GitHubError, mintRunToken, revokeToken, type RunToken } from "./github";
import type { Pins, RunScope } from "./outbound/scope";
import { CA_PATH, interceptHosts, probeEnv, probeSlug, scrubOutput } from "./sandbox";

/** Installation tokens last an hour. Replace one before a long push could outlive it. */
const REFRESH_MS = 10 * 60 * 1000;

/** A run that hasn't finished by then is stopped. exec has no timeout of its own. */
export const RUN_LIMIT_MS = 12 * 60 * 1000;
/** How often the alarm checks the run. An alarm also keeps the container up. */
export const TICK_MS = 10 * 1000;
/** Longer than a tick, so the container outlives the gap between alarms. */
const INACTIVITY_MS = 15 * 60 * 1000;

const OUTPUT_PATH = "/tmp/probe.out";
const EXIT_PATH = "/tmp/probe.exit";

export type Admission = ({ admitted: true } & Pins) | { admitted: false; reason: string };

type Phase = "starting" | "probing" | "done";

/** A failure whose message is safe to post and log. */
class RunError extends Error {}

interface Outcome {
  summary: string;
  output: string;
}

/**
 * One run, from release to teardown. It holds the run's state outside the container:
 * the stop flag, the branch and PR it's pinned to, and its token. The token is held in
 * memory only, so it never reaches storage. If the object is evicted, the next request
 * mints another.
 *
 * It also owns the run's container. An alarm drives it: start the container, run the
 * probe, wait for it, then post the result and tear down. Every exit path calls
 * finish(), which destroys the container and stops the run.
 */
export class RunState extends DurableObject<Env> {
  private token: RunToken | null = null;
  private minting: Promise<RunToken> | null = null;
  /**
   * In memory on purpose. Intercepts last until the container stops, so they're
   * registered once per container. An evicted object comes back with this false and
   * registers them again once.
   */
  private intercepted = false;

  /** Starts a run. Returns at once, because GitHub gives up on a webhook after 10 seconds. */
  async launch(scope: RunScope): Promise<void> {
    if (await this.ctx.storage.get<RunScope>("scope")) return;
    await this.ctx.storage.put({
      scope,
      phase: "starting" satisfies Phase,
      deadline: Date.now() + RUN_LIMIT_MS,
    });
    await this.ctx.storage.setAlarm(Date.now());
  }

  /** Used by tests that drive the run without the alarm. */
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

  override async alarm(): Promise<void> {
    const phase = await this.ctx.storage.get<Phase>("phase");
    if (!phase || phase === "done") return;
    let outcome: Outcome | null;
    try {
      outcome = await this.step(phase);
    } catch (error) {
      const reason = error instanceof RunError || error instanceof GitHubError ? error.message : (error as Error).name;
      outcome = { summary: `The run failed: ${reason}.`, output: "" };
    }
    if (outcome) {
      await this.finish(outcome);
    } else {
      await this.ctx.storage.setAlarm(Date.now() + TICK_MS);
    }
  }

  /** The container this object starts. Tests replace it. */
  protected container(): Container | undefined {
    return this.ctx.container;
  }

  /** One check of the run. Returns how it ended, or null while it's still going. */
  private async step(phase: Phase): Promise<Outcome | null> {
    const container = this.container();
    if (!container) throw new RunError("no container is configured for runs");
    const scope = await this.ctx.storage.get<RunScope>("scope");
    const deadline = await this.ctx.storage.get<number>("deadline");
    if (!scope || deadline === undefined) throw new RunError("the run has no scope");

    if (Date.now() > deadline) {
      return { summary: "The run hit its time limit and was stopped.", output: await this.readOutput(container) };
    }

    // Once per container, not on every check. Registering again while a request is
    // in flight looked like the cause of a 502 in the first live run (#79).
    if (!this.intercepted) {
      await this.intercept(container, scope);
      this.intercepted = true;
    }

    if (!container.running) {
      if (await this.ctx.storage.get<boolean>("started")) {
        return { summary: "The container stopped before the probe finished.", output: await this.readOutput(container) };
      }
      container.start({ image: this.image(container), enableInternet: false, instance: "lite" });
      await this.ctx.storage.put("started", true);
      return null;
    }
    await container.setInactivityTimeout(INACTIVITY_MS);

    if (phase === "starting") {
      // The CA appears once HTTPS is intercepted. Nothing can make an HTTPS call before then.
      if ((await this.run(container, ["test", "-s", CA_PATH])).exitCode !== 0) return null;
      // Output goes to files: a process with piped output gets SIGPIPE when the call
      // that started it ends.
      await container.exec(
        ["/bin/sh", "-c", `/probe/probe.sh > ${OUTPUT_PATH} 2>&1; echo $? > ${EXIT_PATH}`],
        { env: probeEnv(scope, probeSlug(scope.runId)), stdout: "ignore", stderr: "ignore" },
      );
      await this.ctx.storage.put("phase", "probing" satisfies Phase);
      return null;
    }

    const exit = await this.run(container, ["cat", EXIT_PATH]);
    if (exit.exitCode !== 0) return null;
    const code = exit.stdout.trim();
    return {
      summary: code === "0" ? "Every probe check passed." : `Some probe checks failed (exit ${code}).`,
      output: await this.readOutput(container),
    };
  }

  private image(container: Container): string {
    const image = container.images.probe;
    if (!image) throw new RunError("the probe image isn't configured");
    return image;
  }

  private async intercept(container: Container, scope: RunScope): Promise<void> {
    const outbound = (this.ctx.exports as unknown as {
      Outbound: (options: { props: RunScope }) => Fetcher;
    }).Outbound({ props: scope });
    for (const host of interceptHosts(this.env, scope.repo)) {
      await container.interceptOutboundHttps(host, outbound);
    }
  }

  private async run(container: Container, command: string[]): Promise<{ exitCode: number; stdout: string }> {
    const process = await container.exec(command, { stdout: "pipe", stderr: "ignore" });
    const output = await process.output();
    return { exitCode: output.exitCode, stdout: new TextDecoder().decode(output.stdout) };
  }

  private async readOutput(container: Container): Promise<string> {
    try {
      if (!container.running) return "";
      return (await this.run(container, ["head", "-c", "65536", OUTPUT_PATH])).stdout;
    } catch {
      return "";
    }
  }

  /** Tears down, reports, and stops the run, whatever happened before. */
  private async finish(outcome: Outcome): Promise<void> {
    await this.ctx.storage.put("phase", "done" satisfies Phase);
    await this.ctx.storage.deleteAlarm();
    try {
      const container = this.container();
      if (container?.running) await container.destroy();
    } catch (error) {
      console.error(`Destroying a run's container failed: ${(error as Error).name}`);
    }
    try {
      await this.report(outcome);
    } catch (error) {
      const reason = error instanceof GitHubError ? error.message : (error as Error).name;
      console.error(`Reporting a run failed: ${reason}`);
    }
    await this.stop();
  }

  private async report(outcome: Outcome): Promise<void> {
    const scope = await this.ctx.storage.get<RunScope>("scope");
    if (!scope) return;
    const token = await this.accessToken();
    const output = scrubOutput(outcome.output, [token]);
    const body = [
      `Outbound probe run \`${scope.runId}\` (build \`${this.env.BUILD_ID}\`): ${outcome.summary}`,
      output ? `\n\`\`\`\n${output}\n\`\`\`` : "",
    ].join("\n");
    await commentOnIssue(token, scope.repo, scope.issue, body);
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
