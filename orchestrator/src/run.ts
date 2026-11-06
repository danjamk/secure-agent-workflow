import { DurableObject } from "cloudflare:workers";
import { RUNNERS, type RunContext, type Runner, type RunReport } from "./agents";
import { commentOnIssue, editComment, findComment, getIssue, GitHubError, mintRunToken, revokeToken, type RunToken } from "./github";
import type { Pins, RunScope } from "./outbound/scope";
import { CA_PATH, interceptHosts, scrubOutput } from "./sandbox";

/** Installation tokens last an hour. Replace one before a long push could outlive it. */
const REFRESH_MS = 10 * 60 * 1000;
/** How often the alarm checks the run. An alarm also keeps the container up. */
export const TICK_MS = 10 * 1000;
/** Longer than a tick, so the container outlives the gap between alarms. */
const INACTIVITY_MS = 15 * 60 * 1000;

const LOG_PATH = "/workspace/task/run.log";
const EXIT_PATH = "/workspace/task/run.exit";
const MAX_READ = 65_536;

export type Admission = ({ admitted: true } & Pins) | { admitted: false; reason: string };

type Phase = "starting" | "running" | "done";

/** A failure whose message is safe to post and log. */
class RunError extends Error {}

/** The key for "one run per issue", by the repo's immutable id. */
export function issueKey(scope: RunScope): string {
  return `${scope.repoId}#${scope.issue}`;
}

function toBase64(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
}

/**
 * One run, from release to teardown. It holds the run's state outside the container:
 * the stop flag, the branch and PR it's pinned to, and its token. The token is held in
 * memory only, so it never reaches storage. If the object is evicted, the next request
 * mints another.
 *
 * It also owns the run's container. An alarm drives it: post the status comment,
 * start the container, write the runner's files, start its command, wait for it, then
 * report and tear down. Every exit path calls finish(), which destroys the container,
 * edits the status comment, releases the issue and stops the run.
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
  async launch(scope: RunScope, runner: string): Promise<void> {
    if (await this.ctx.storage.get<RunScope>("scope")) return;
    const chosen = RUNNERS[runner];
    if (!chosen) throw new RunError(`no runner named ${runner}`);
    await this.ctx.storage.put({
      scope,
      runner,
      phase: "starting" satisfies Phase,
      deadline: Date.now() + chosen.limitMs,
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
    let report: RunReport | null;
    try {
      report = await this.step(phase);
    } catch (error) {
      const reason = error instanceof RunError || error instanceof GitHubError ? error.message : (error as Error).name;
      report = { summary: `The run failed: ${reason}.`, output: "" };
    }
    if (report) {
      await this.finish(report);
    } else {
      await this.ctx.storage.setAlarm(Date.now() + TICK_MS);
    }
  }

  /** The container this object starts. Tests replace it. */
  protected container(): Container | undefined {
    return this.ctx.container;
  }

  private async runner(): Promise<Runner> {
    const name = (await this.ctx.storage.get<string>("runner")) ?? "";
    const runner = RUNNERS[name];
    if (!runner) throw new RunError(`no runner named ${name || "(none)"}`);
    return runner;
  }

  /** One check of the run. Returns how it ended, or null while it's still going. */
  private async step(phase: Phase): Promise<RunReport | null> {
    const scope = await this.ctx.storage.get<RunScope>("scope");
    const deadline = await this.ctx.storage.get<number>("deadline");
    if (!scope || deadline === undefined) throw new RunError("the run has no scope");
    await this.postStatus(scope);

    const container = this.container();
    if (!container) throw new RunError("no container is configured for runs");
    const runner = await this.runner();

    if (Date.now() > deadline) {
      return {
        summary: `The run hit its ${Math.round(runner.limitMs / 60_000)}-minute limit and was stopped.`,
        output: await this.read(container, LOG_PATH),
      };
    }

    // Once per container, not on every check. Registering again while a request was
    // in flight looked like the cause of a 502 in the first live probe (#79).
    if (!this.intercepted) {
      await this.intercept(container, scope);
      this.intercepted = true;
    }

    if (!container.running) {
      if (await this.ctx.storage.get<boolean>("started")) {
        return { summary: "The container stopped before the run finished.", output: await this.read(container, LOG_PATH) };
      }
      container.start({ image: this.image(container), enableInternet: false, instance: runner.instance });
      await this.ctx.storage.put("started", true);
      return null;
    }
    await container.setInactivityTimeout(INACTIVITY_MS);

    if (phase === "starting") {
      // The CA appears once HTTPS is intercepted. Nothing can make an HTTPS call before then.
      if ((await this.run(container, ["test", "-s", CA_PATH])).exitCode !== 0) return null;
      const context: RunContext = {
        scope,
        issue: await getIssue(await this.accessToken(), scope.repo, scope.issue),
        env: this.env,
      };
      for (const [path, content] of Object.entries(runner.files(context))) {
        await this.writeFile(container, path, content);
      }
      const { script, env, user } = runner.command(context);
      // Output goes to files: a process with piped output gets SIGPIPE when the call
      // that started it ends.
      await container.exec(["/bin/sh", "-c", `${script} > ${LOG_PATH} 2>&1; echo $? > ${EXIT_PATH}`], {
        env,
        user,
        stdout: "ignore",
        stderr: "ignore",
      });
      await this.ctx.storage.put("phase", "running" satisfies Phase);
      return null;
    }

    const exit = await this.run(container, ["cat", EXIT_PATH]);
    if (exit.exitCode !== 0) return null;
    return runner.report(exit.stdout.trim(), await this.read(container, LOG_PATH), (path) =>
      this.read(container, path),
    );
  }

  private image(container: Container): string {
    const image = container.images.agent;
    if (!image) throw new RunError("the agent image isn't configured");
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

  /** Passed as an argument, so nothing in the content is read by a shell. */
  private async writeFile(container: Container, path: string, content: string): Promise<void> {
    const written = await this.run(container, [
      "/bin/sh",
      "-c",
      'printf %s "$1" | base64 -d > "$2" && chmod 0644 "$2"',
      "write-file",
      toBase64(content),
      path,
    ]);
    if (written.exitCode !== 0) throw new RunError(`writing ${path} into the container failed`);
  }

  private async read(container: Container, path: string): Promise<string> {
    try {
      if (!container.running) return "";
      const result = await this.run(container, ["head", "-c", String(MAX_READ), path]);
      return result.exitCode === 0 ? result.stdout : "";
    } catch {
      return "";
    }
  }

  private async describe(scope: RunScope): Promise<string> {
    const runner = (await this.ctx.storage.get<string>("runner")) ?? "unknown";
    return `Run \`${scope.runId}\` (build \`${this.env.BUILD_ID}\`, runner \`${runner}\`)`;
  }

  /** The run's one status comment, posted on the first check. A failure here doesn't stop the run. */
  private async postStatus(scope: RunScope): Promise<void> {
    if (await this.ctx.storage.get<boolean>("statusTried")) return;
    await this.ctx.storage.put("statusTried", true);
    try {
      const body = `${await this.describe(scope)} started. This comment is updated when the run ends.`;
      const id = await commentOnIssue(await this.accessToken(), scope.repo, scope.issue, body);
      await this.ctx.storage.put("statusComment", id);
    } catch (error) {
      const reason = error instanceof GitHubError ? error.message : (error as Error).name;
      console.error(`Posting a run's status comment failed: ${reason}`);
    }
  }

  /** Tears down, reports, releases the issue and stops the run, whatever happened before. */
  private async finish(report: RunReport): Promise<void> {
    await this.ctx.storage.put("phase", "done" satisfies Phase);
    await this.ctx.storage.deleteAlarm();
    try {
      const container = this.container();
      if (container?.running) await container.destroy();
    } catch (error) {
      console.error(`Destroying a run's container failed: ${(error as Error).name}`);
    }
    const scope = await this.ctx.storage.get<RunScope>("scope");
    try {
      if (scope) await this.report(scope, report);
    } catch (error) {
      const reason = error instanceof GitHubError ? error.message : (error as Error).name;
      console.error(`Reporting a run failed: ${reason}`);
    }
    if (scope) {
      try {
        await this.env.DELIVERY_LOG.getByName("global").releaseIssue(issueKey(scope), scope.runId);
      } catch (error) {
        console.error(`Releasing a run's issue failed: ${(error as Error).name}`);
      }
    }
    await this.stop();
  }

  private async report(scope: RunScope, report: RunReport): Promise<void> {
    const token = await this.accessToken();
    const pr = await this.ctx.storage.get<Pins["pr"]>("pr");
    const output = scrubOutput(report.output, [token]);
    const body = [
      `${await this.describe(scope)}: ${report.summary}`,
      pr ? `\nPR: #${pr.number}` : "",
      output ? `\n\`\`\`\n${output}\n\`\`\`` : "",
    ].join("\n");
    // If posting the start comment failed after GitHub made it, find it by the run id
    // so the run still ends with one comment.
    const id =
      (await this.ctx.storage.get<number>("statusComment")) ??
      (await findComment(token, scope.repo, scope.issue, `Run \`${scope.runId}\``));
    if (id === undefined) {
      await commentOnIssue(token, scope.repo, scope.issue, body);
    } else {
      await editComment(token, scope.repo, id, body);
    }
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
