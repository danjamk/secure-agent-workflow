import { caEnv } from "../sandbox";
import type { Runner } from "./index";

/** A branch name the probe can use: agent/<issue>-probe-<8 hex>. */
export function probeSlug(runId: string): string {
  return `probe-${runId.replace(/[^0-9a-f]/gi, "").slice(0, 8).toLowerCase()}`;
}

/**
 * The outbound probe (#79): a fixed script that tries what an agent might and
 * reports what got through. Picked by the agent:probe label, to recheck the policy
 * after it changes.
 */
export const probe: Runner = {
  name: "probe",
  instance: "lite",
  limitMs: 12 * 60 * 1000,

  files() {
    return {};
  },

  command({ scope }) {
    return {
      script: "/agent/probe.sh",
      env: {
        REPO: scope.repo,
        ISSUE: String(scope.issue),
        SLUG: probeSlug(scope.runId),
        DEFAULT_BRANCH: scope.defaultBranch,
        HOME: "/root",
        ...caEnv(),
      },
    };
  },

  async report(exitCode, log) {
    return {
      summary: exitCode === "0" ? "Every probe check passed." : `Some probe checks failed (exit ${exitCode}).`,
      output: log,
    };
  },
};
