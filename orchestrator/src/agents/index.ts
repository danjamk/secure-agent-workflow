import type { RunScope } from "../outbound/scope";
import { claudeCode } from "./claude-code";
import { probe } from "./probe";

/** What a resumed run continues from (#11). */
export interface Resume {
  /** The branch name, without refs/heads/. */
  branch: string;
  pr: number | null;
  /** The approver's reply that resumed the run. */
  reply: string;
}

/** What a runner gets to build its command. Nothing in it is a credential. */
export interface RunContext {
  scope: RunScope;
  issue: { title: string; body: string };
  resume: Resume | null;
  env: Env;
}

export interface RunReport {
  summary: string;
  /** The run ended waiting for the approver, not finished or failed. A reply resumes it. */
  blocked?: boolean;
  /** Shown in a code block under the summary. It comes from the container, so it's scrubbed first. */
  output: string;
}

/**
 * Everything specific to one kind of run. Adding an agent CLI is a new module that
 * implements this, plus one line in RUNNERS (#9).
 */
export interface Runner {
  name: string;
  instance: NonNullable<ContainerStartupOptions["instance"]>;
  /** The run is stopped after this long. */
  limitMs: number;
  /** Written into the container before the command runs, path to content. */
  files(context: RunContext): Record<string, string>;
  /** The script to run, its environment, and the uid:gid to run it as. */
  command(context: RunContext): { script: string; env: Record<string, string>; user?: string };
  /** How the run ended. `read` returns a file from the container, or "" if it's missing. */
  report(exitCode: string, log: string, read: (path: string) => Promise<string>): Promise<RunReport>;
}

export const RUNNERS: Record<string, Runner> = {
  [claudeCode.name]: claudeCode,
  [probe.name]: probe,
};

/** The label that picks the probe instead of the agent. */
export const PROBE_LABEL = "agent:probe";

export function runnerFor(labels: string[]): Runner {
  return labels.includes(PROBE_LABEL) ? probe : claudeCode;
}
