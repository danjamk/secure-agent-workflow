import { deny, hasOnlyKeys, type Deny, type Pins, type RunScope } from "./scope";

export type RestDecision = { allow: true; body?: string; pinPullRequest?: boolean } | Deny;

const MAX_TITLE = 1024;
const MAX_TEXT = 65536;

/** Plain segments only. A %, such as %2F, could reach a different route on GitHub. */
const READ_SUFFIX = /^(?:\/[A-Za-z0-9._~:@+,-]+)*$/;

const CLOSING =
  /\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\b[\s:*_]*(?:(?:https?:\/\/)?(?:www\.)?(?:github\.com\/)?([\w.-]+\/[\w.-]+)(?:#|\/(?:issues|pull)\/)|#|GH-)(\d+)/gi;

/** Merging this text would close a different issue, such as a blocker (ADR-005). */
export function closesAnotherIssue(text: string, scope: RunScope): boolean {
  for (const [, repo, number] of text.matchAll(CLOSING)) {
    if (repo && repo.toLowerCase() !== scope.repo.toLowerCase()) return true;
    if (Number(number) !== scope.issue) return true;
  }
  return false;
}

function isText(value: unknown, max: number): value is string {
  return typeof value === "string" && value.length <= max;
}

/** Title and body as a PR may have them, or the reason they can't. */
function checkPrText(body: Record<string, unknown>, scope: RunScope): string | null {
  const { title, body: text } = body;
  if (title !== undefined && !isText(title, MAX_TITLE)) return "bad title";
  if (text !== undefined && !isText(text, MAX_TEXT)) return "bad body";
  for (const value of [title, text]) {
    if (typeof value === "string" && closesAnotherIssue(value, scope)) {
      return "closes another issue";
    }
  }
  return null;
}

function createPull(body: unknown, scope: RunScope, pins: Pins): RestDecision {
  if (pins.pr) return deny("rest: the run already has a PR");
  if (!pins.branch) return deny("rest: push the run's branch first");
  if (!hasOnlyKeys(body, ["title", "body", "head", "base", "draft"])) {
    return deny("rest: unexpected field in the PR");
  }
  if (body.head !== pins.branch.replace("refs/heads/", "")) {
    return deny("rest: the PR's head must be the run's branch");
  }
  if (body.base !== scope.defaultBranch) return deny("rest: the PR's base must be the default branch");
  if (typeof body.title !== "string") return deny("rest: the PR needs a title");
  if (body.draft !== undefined && typeof body.draft !== "boolean") return deny("rest: bad draft");
  const problem = checkPrText(body, scope);
  if (problem) return deny(`rest: ${problem}`);
  return { allow: true, body: JSON.stringify(body), pinPullRequest: true };
}

function updatePull(body: unknown, scope: RunScope): RestDecision {
  if (!hasOnlyKeys(body, ["title", "body"])) return deny("rest: only a PR's title and body");
  const problem = checkPrText(body, scope);
  if (problem) return deny(`rest: ${problem}`);
  return { allow: true, body: JSON.stringify(body) };
}

function comment(body: unknown): RestDecision {
  if (!hasOnlyKeys(body, ["body"]) || !isText(body.body, MAX_TEXT)) return deny("rest: bad comment");
  return { allow: true, body: JSON.stringify({ body: body.body }) };
}

/** Accepts both of GitHub's forms. Forwards one, so the two can't be read differently. */
function addBlocked(body: unknown): RestDecision {
  const labels = Array.isArray(body) ? body : hasOnlyKeys(body, ["labels"]) ? body.labels : null;
  if (!Array.isArray(labels) || labels.length !== 1 || labels[0] !== "agent:blocked") {
    return deny("rest: the only label a run can add is agent:blocked");
  }
  return { allow: true, body: JSON.stringify({ labels: ["agent:blocked"] }) };
}

/**
 * The GitHub REST calls a run can make, by default denied. Reads stay in the run's
 * repo, and each write is listed and tied to the run's own branch, issue or PR. That
 * leaves out reviews, merges, /git/refs, /contents, editing an issue, removing a label
 * (agent:stop included), and any other PR.
 */
export function decideRest(
  method: string,
  pathname: string,
  body: unknown,
  scope: RunScope,
  pins: Pins,
): RestDecision {
  const prefix = `/repos/${scope.repo}`;
  if (pathname !== prefix && !pathname.startsWith(`${prefix}/`)) {
    return deny("rest: only the run's repo");
  }
  const rest = pathname.slice(prefix.length);

  if (method === "GET" || method === "HEAD") {
    if (!READ_SUFFIX.test(rest) || /\/\.\.?(?:\/|$)/.test(rest)) return deny("rest: unexpected path");
    return { allow: true };
  }

  if (method === "POST" && rest === "/pulls") return createPull(body, scope, pins);

  const pull = rest.match(/^\/pulls\/([1-9]\d*)$/);
  if (method === "PATCH" && pull) {
    if (Number(pull[1]) !== pins.pr?.number) return deny("rest: only the run's own PR");
    return updatePull(body, scope);
  }

  const comments = rest.match(/^\/issues\/([1-9]\d*)\/comments$/);
  if (method === "POST" && comments) {
    const number = Number(comments[1]);
    if (number !== scope.issue && number !== pins.pr?.number) {
      return deny("rest: comment only on the run's issue or PR");
    }
    return comment(body);
  }

  const labels = rest.match(/^\/issues\/([1-9]\d*)\/labels$/);
  if (method === "POST" && labels) {
    if (Number(labels[1]) !== scope.issue) return deny("rest: label only the run's issue");
    return addBlocked(body);
  }

  return deny("rest: call not allowed");
}
