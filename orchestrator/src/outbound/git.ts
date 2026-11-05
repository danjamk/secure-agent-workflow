import { deny, type Deny, type Pins, type RunScope } from "./scope";

export type GitCall = "read" | "fetch" | "push";

/** Git over HTTPS for this run's repo, and nothing else on github.com. No LFS. */
export function decideGit(
  method: string,
  pathname: string,
  search: string,
  scope: RunScope,
): { allow: true; call: GitCall } | Deny {
  const repo = `/${scope.repo}.git`;
  if (pathname === `${repo}/info/refs` && (method === "GET" || method === "HEAD")) {
    if (search === "?service=git-upload-pack" || search === "?service=git-receive-pack") {
      return { allow: true, call: "read" };
    }
    return deny("git: unknown service");
  }
  if (search === "" && method === "POST") {
    if (pathname === `${repo}/git-upload-pack`) return { allow: true, call: "fetch" };
    if (pathname === `${repo}/git-receive-pack`) return { allow: true, call: "push" };
  }
  return deny("github.com: only git for this run's repo");
}

export type PktScan =
  | { kind: "more" }
  | { kind: "bad"; reason: string }
  | { kind: "flush"; lines: string[]; end: number };

/**
 * Reads the pkt-lines before the first flush, which are a push's ref commands.
 * The pack data follows the flush and is never parsed.
 */
export function scanCommands(bytes: Uint8Array): PktScan {
  const decoder = new TextDecoder();
  const lines: string[] = [];
  let at = 0;
  while (at + 4 <= bytes.length) {
    const hex = decoder.decode(bytes.subarray(at, at + 4));
    if (!/^[0-9a-fA-F]{4}$/.test(hex)) return { kind: "bad", reason: "git: bad pkt-line length" };
    const length = parseInt(hex, 16);
    if (length === 0) return { kind: "flush", lines, end: at + 4 };
    // 0001 and 0002 are protocol v2 markers, which receive-pack doesn't use.
    if (length < 4) return { kind: "bad", reason: "git: unexpected pkt-line marker" };
    if (at + length > bytes.length) return { kind: "more" };
    lines.push(decoder.decode(bytes.subarray(at + 4, at + length)));
    at += length;
  }
  return { kind: "more" };
}

const COMMAND = /^([0-9a-f]{40}|[0-9a-f]{64}) ([0-9a-f]{40}|[0-9a-f]{64}) (\S+)$/;
const CAPABILITIES = new Set([
  "report-status",
  "report-status-v2",
  "side-band-64k",
  "quiet",
  "atomic",
  "ofs-delta",
]);
const CAPABILITY_WITH_VALUE = /^(agent|session-id|object-format)=\S+$/;

export function branchPattern(issue: number): RegExp {
  return new RegExp(`^refs/heads/agent/${issue}-[a-z0-9]+(?:-[a-z0-9]+)*$`);
}

/**
 * Checks a push's ref commands. No commands is git's probe before a large push.
 *
 * The commands can't show a force-push: that needs the commit graph, and the new
 * objects aren't on GitHub yet. A ruleset on agent/** blocks those (bootstrap.sh).
 * Shallow lines and push certificates fail the command format, so they're denied.
 */
export function decidePush(
  lines: string[],
  scope: RunScope,
  pins: Pins,
): { allow: true; ref: string | null } | Deny {
  if (lines.length === 0) return { allow: true, ref: null };
  if (lines.length > 1) return deny("push: one ref per push");

  const [text = "", capabilities = ""] = (lines[0] ?? "").replace(/\n$/, "").split("\0");
  const command = text.match(COMMAND);
  if (!command) return deny("push: unexpected command");
  for (const capability of capabilities.split(" ").filter(Boolean)) {
    if (!CAPABILITIES.has(capability) && !CAPABILITY_WITH_VALUE.test(capability)) {
      return deny("push: capability not allowed");
    }
  }

  const [, , next = "", ref = ""] = command;
  if (/^0+$/.test(next)) return deny("push: branch deletion");
  if (!branchPattern(scope.issue).test(ref)) {
    return deny(`push: only agent/${scope.issue}-<slug>`);
  }
  if (pins.branch && pins.branch !== ref) return deny("push: the run already has a branch");
  return { allow: true, ref };
}
