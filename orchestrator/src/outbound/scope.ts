/**
 * What one run may touch. Set by the orchestrator when it starts the container and
 * passed to the Outbound entrypoint as props, so nothing in the container can read
 * or change it.
 */
export interface RunScope {
  runId: string;
  installationId: number;
  /** Immutable, unlike the name. The run's token is minted for this id. */
  repoId: number;
  /** owner/name, as GitHub reports it. */
  repo: string;
  issue: number;
  defaultBranch: string;
}

export interface PullRequest {
  number: number;
  nodeId: string;
}

/** What the run has created so far. Starts empty, and each is set once. */
export interface Pins {
  /** The full ref, refs/heads/agent/<issue>-<slug>. */
  branch: string | null;
  pr: PullRequest | null;
}

export interface Deny {
  allow: false;
  reason: string;
}

export function deny(reason: string): Deny {
  return { allow: false, reason };
}

/** A JSON object with only the listed keys. An unknown key could change what a call does. */
export function hasOnlyKeys(value: unknown, keys: string[]): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  return Object.keys(value).every((key) => keys.includes(key));
}
