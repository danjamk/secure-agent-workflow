import { describe, expect, it } from "vitest";
import { decideGit, decidePush, scanCommands } from "../../src/outbound/git";
import { decideGraphql } from "../../src/outbound/graphql";
import { decideModel, MODEL_HOSTS } from "../../src/outbound/models";
import { closesAnotherIssue, decideRest } from "../../src/outbound/rest";
import { BRANCH, FLUSH, join, command, NEW, noPins, OLD, pinned, PR, pkt, REPO, scope, ZERO } from "./helpers";

const run = scope();

function pushLines(bytes: Uint8Array): string[] {
  const scan = scanCommands(bytes);
  if (scan.kind !== "flush") throw new Error(`no flush: ${scan.kind}`);
  return scan.lines;
}

describe("git routes", () => {
  it.each([
    ["GET", `/${REPO}.git/info/refs`, "?service=git-upload-pack"],
    ["GET", `/${REPO}.git/info/refs`, "?service=git-receive-pack"],
    ["POST", `/${REPO}.git/git-upload-pack`, ""],
    ["POST", `/${REPO}.git/git-receive-pack`, ""],
  ])("allows %s %s%s", (method, path, search) => {
    expect(decideGit(method, path, search, run).allow).toBe(true);
  });

  it.each([
    ["another repo", "GET", "/the-approver/other.git/info/refs", "?service=git-upload-pack"],
    ["another owner", "POST", `/someone/app.git/git-receive-pack`, ""],
    ["no .git suffix", "GET", `/${REPO}/info/refs`, "?service=git-upload-pack"],
    ["a different case", "GET", `/THE-APPROVER/app.git/info/refs`, "?service=git-upload-pack"],
    ["an unknown service", "GET", `/${REPO}.git/info/refs`, "?service=git-upload-archive"],
    ["a dumb-protocol read", "GET", `/${REPO}.git/HEAD`, ""],
    ["LFS", "POST", `/${REPO}.git/info/lfs/objects/batch`, ""],
    ["a query on a push", "POST", `/${REPO}.git/git-receive-pack`, "?x=1"],
    ["the website", "GET", `/${REPO}/settings`, ""],
  ])("denies %s", (_name, method, path, search) => {
    expect(decideGit(method, path, search, run).allow).toBe(false);
  });
});

describe("push commands", () => {
  const decide = (bytes: Uint8Array, pins = noPins) => decidePush(pushLines(bytes), run, pins);

  it("allows the run's first push, creating its branch", () => {
    expect(decide(join(command(BRANCH, NEW, ZERO), FLUSH))).toEqual({ allow: true, ref: BRANCH });
  });

  it("allows an update of the pinned branch", () => {
    expect(decide(join(command(BRANCH), FLUSH), pinned)).toEqual({ allow: true, ref: BRANCH });
  });

  it("allows git's empty probe", () => {
    expect(decide(FLUSH)).toEqual({ allow: true, ref: null });
  });

  it.each([
    ["main", "refs/heads/main"],
    ["production", "refs/heads/production"],
    ["another issue's branch", "refs/heads/agent/8-add-parser"],
    ["an issue number prefix", "refs/heads/agent/77-add-parser"],
    ["agent with no issue", "refs/heads/agent/add-parser"],
    ["a developer's branch", "refs/heads/feature/7-add-parser"],
    ["a tag", "refs/tags/agent/7-add-parser"],
    ["a nested ref", "refs/heads/agent/7-add/parser"],
    ["uppercase", "refs/heads/agent/7-Add-parser"],
    ["a notes ref", "refs/notes/commits"],
  ])("denies a push to %s", (_name, ref) => {
    expect(decide(join(command(ref), FLUSH)).allow).toBe(false);
  });

  it("denies deleting the run's own branch", () => {
    const verdict = decide(join(command(BRANCH, ZERO), FLUSH), pinned);
    expect(verdict).toEqual({ allow: false, reason: "push: branch deletion" });
  });

  it("denies a second branch", () => {
    const other = "refs/heads/agent/7-another-branch";
    expect(decide(join(command(other), FLUSH), pinned).allow).toBe(false);
  });

  it("denies several refs in one push, even when the first is allowed", () => {
    const body = join(command(BRANCH), pkt(`${OLD} ${NEW} refs/heads/main\n`), FLUSH);
    expect(decide(body).allow).toBe(false);
  });

  it.each([
    ["a shallow line", pkt(`shallow ${OLD}\n`)],
    ["a push certificate", pkt("push-cert\0report-status\n")],
    ["a space in the ref", pkt(`${OLD} ${NEW} ${BRANCH} refs/heads/main\n`)],
    ["a short sha", pkt(`abc ${NEW} ${BRANCH}\n`)],
  ])("denies %s", (_name, line) => {
    expect(decide(join(line, FLUSH)).allow).toBe(false);
  });

  it("denies push options, which GitHub would read after the flush", () => {
    const body = join(command(BRANCH, NEW, OLD, "report-status push-options"), FLUSH);
    expect(decide(body).allow).toBe(false);
  });

  it("reports bad and unfinished pkt-lines", () => {
    expect(scanCommands(new TextEncoder().encode("zzzz")).kind).toBe("bad");
    expect(scanCommands(new TextEncoder().encode("0001")).kind).toBe("bad");
    expect(scanCommands(new TextEncoder().encode("00ff")).kind).toBe("more");
    expect(scanCommands(pkt("half")).kind).toBe("more");
  });
});

describe("REST", () => {
  const decide = (method: string, path: string, body?: unknown, pins = pinned, target = run) =>
    decideRest(method, path, body, target, pins);
  const repo = `/repos/${REPO}`;

  it.each([
    [repo],
    [`${repo}/issues/7`],
    [`${repo}/pulls/99/files`],
    [`${repo}/labels/agent:stop`],
    [`${repo}/compare/main...agent/7-add-parser`],
  ])("allows reading %s", (path) => {
    expect(decide("GET", path).allow).toBe(true);
    expect(decide("HEAD", path).allow).toBe(true);
  });

  it.each([
    ["another repo", "/repos/the-approver/other"],
    ["a name with the run's repo as a prefix", `${repo}-private/issues`],
    ["the App's installation", "/installation/repositories"],
    ["the user", "/user"],
    ["an encoded slash", `/repos/the-approver%2Fother`],
    ["an encoded slash inside the repo", `${repo}/%2e%2e/%2e%2e/other`],
    ["a dot segment", `${repo}/../other`],
    ["another case", `/REPOS/${REPO}`],
  ])("denies reading %s", (_name, path) => {
    expect(decide("GET", path).allow).toBe(false);
  });

  const pull = { title: "Add parser", body: "Closes #7", head: "agent/7-add-parser", base: "main", draft: true };

  it("allows the run's PR once, and asks to pin it", () => {
    const pins = { branch: BRANCH, pr: null };
    expect(decide("POST", `${repo}/pulls`, pull, pins)).toEqual({
      allow: true,
      body: JSON.stringify(pull),
      pinPullRequest: true,
    });
    expect(decide("POST", `${repo}/pulls`, pull, pinned).allow).toBe(false);
  });

  it.each([
    ["before the branch is pushed", pull, noPins],
    ["from another branch", { ...pull, head: "agent/7-other" }, { branch: BRANCH, pr: null }],
    ["from a fork", { ...pull, head: "someone:agent/7-add-parser" }, { branch: BRANCH, pr: null }],
    ["into another base", { ...pull, base: "production" }, { branch: BRANCH, pr: null }],
    ["with no title", { head: pull.head, base: "main" }, { branch: BRANCH, pr: null }],
    ["converting an issue", { ...pull, issue: 3 }, { branch: BRANCH, pr: null }],
    ["closing another issue", { ...pull, body: "Closes #99" }, { branch: BRANCH, pr: null }],
    ["closing another issue from the title", { ...pull, title: "Fixes #99" }, { branch: BRANCH, pr: null }],
  ])("denies creating a PR %s", (_name, body, pins) => {
    expect(decide("POST", `${repo}/pulls`, body, pins).allow).toBe(false);
  });

  it("allows editing the run's own PR text", () => {
    expect(decide("PATCH", `${repo}/pulls/${PR.number}`, { body: "Updated" }).allow).toBe(true);
  });

  it.each([
    ["another run's PR", `${repo}/pulls/99`, { body: "x" }],
    ["its state", `${repo}/pulls/${PR.number}`, { state: "closed" }],
    ["its base", `${repo}/pulls/${PR.number}`, { base: "production" }],
    ["its text to close a blocker", `${repo}/pulls/${PR.number}`, { body: "Resolves: #99" }],
  ])("denies editing %s", (_name, path, body) => {
    expect(decide("PATCH", path, body).allow).toBe(false);
  });

  it("allows comments on the run's issue and PR, and no others", () => {
    expect(decide("POST", `${repo}/issues/7/comments`, { body: "Blocked" }).allow).toBe(true);
    expect(decide("POST", `${repo}/issues/${PR.number}/comments`, { body: "x" }).allow).toBe(true);
    expect(decide("POST", `${repo}/issues/99/comments`, { body: "x" }).allow).toBe(false);
    expect(decide("POST", `${repo}/issues/7/comments`, { body: 3 }).allow).toBe(false);
    expect(decide("POST", `${repo}/issues/7/comments`, { body: "x", extra: 1 }).allow).toBe(false);
  });

  it("allows adding only agent:blocked, only to the run's issue", () => {
    const blocked = { labels: ["agent:blocked"] };
    expect(decide("POST", `${repo}/issues/7/labels`, blocked).allow).toBe(true);
    expect(decide("POST", `${repo}/issues/7/labels`, ["agent:blocked"]).allow).toBe(true);
    expect(decide("POST", `${repo}/issues/99/labels`, blocked).allow).toBe(false);
    expect(decide("POST", `${repo}/issues/${PR.number}/labels`, blocked).allow).toBe(false);
    expect(decide("POST", `${repo}/issues/7/labels`, { labels: ["agent:ready"] }).allow).toBe(false);
    expect(decide("POST", `${repo}/issues/7/labels`, { labels: ["agent:blocked", "x"] }).allow).toBe(false);
  });

  it.each([
    ["removing agent:stop", "DELETE", `${repo}/issues/7/labels/agent:stop`],
    ["replacing labels", "PUT", `${repo}/issues/7/labels`],
    ["removing all labels", "DELETE", `${repo}/issues/7/labels`],
    ["closing an issue", "PATCH", `${repo}/issues/99`],
    ["editing the run's issue", "PATCH", `${repo}/issues/7`],
    ["a review", "POST", `${repo}/pulls/${PR.number}/reviews`],
    ["a review comment", "POST", `${repo}/pulls/${PR.number}/comments`],
    ["a merge", "PUT", `${repo}/pulls/${PR.number}/merge`],
    ["updating the branch", "PUT", `${repo}/pulls/${PR.number}/update-branch`],
    ["creating a ref", "POST", `${repo}/git/refs`],
    ["updating a ref", "PATCH", `${repo}/git/refs/heads/main`],
    ["deleting a ref", "DELETE", `${repo}/git/refs/heads/agent/7-add-parser`],
    ["writing a file", "PUT", `${repo}/contents/README.md`],
    ["a repo merge", "POST", `${repo}/merges`],
    ["a workflow dispatch", "POST", `${repo}/actions/workflows/1/dispatches`],
    ["a repo dispatch", "POST", `${repo}/dispatches`],
    ["editing a comment", "PATCH", `${repo}/issues/comments/1`],
    ["a repo setting", "PATCH", repo],
    ["a new installation token", "POST", "/app/installations/99/access_tokens"],
  ])("denies %s", (_name, method, path) => {
    expect(decide(method, path, {}).allow).toBe(false);
  });

  it("rebuilds a write from what it checked", () => {
    const verdict = decide("POST", `${repo}/issues/7/labels`, ["agent:blocked"]);
    expect(verdict).toMatchObject({ body: '{"labels":["agent:blocked"]}' });
  });
});

describe("closing keywords", () => {
  it.each([
    "Closes #99",
    "fixes #99",
    "RESOLVED: #99",
    "**Closes** #99",
    "closes GH-99",
    "fixes the-approver/app#99",
    "fixes the-approver/other#7",
    "closes https://github.com/the-approver/app/issues/99",
    "closes #7 and fixes #99",
  ])("catches %s", (text) => {
    expect(closesAnotherIssue(text, run)).toBe(true);
  });

  it.each([
    "Closes #7",
    "fixes the-approver/app#7",
    "closes https://github.com/the-approver/app/issues/7",
    "Related to #99",
    "This disclosed #99",
    "No keywords here",
  ])("allows %s", (text) => {
    expect(closesAnotherIssue(text, run)).toBe(false);
  });
});

describe("GraphQL", () => {
  const ready = `mutation { markPullRequestReadyForReview(input: { pullRequestId: "${PR.nodeId}" }) { pullRequest { id } } }`;
  const decide = (body: unknown, pins = pinned) => decideGraphql(body, pins);

  it.each([
    ["a named query", "query Q { repository(owner: \"a\", name: \"b\") { id } }"],
    ["a shorthand query", "{ viewer { login } }"],
    ["a query with fragments", "query { viewer { ...F } } fragment F on User { login }"],
  ])("allows %s", (_name, query) => {
    expect(decide({ query }).allow).toBe(true);
  });

  it("allows marking the run's own PR ready", () => {
    expect(decide({ query: ready }).allow).toBe(true);
  });

  it("allows auto-merge on the run's own PR, by variable", () => {
    const query = `mutation M($id: ID!) { enablePullRequestAutoMerge(input: { pullRequestId: $id, mergeMethod: SQUASH }) { clientMutationId } }`;
    expect(decide({ query, variables: { id: PR.nodeId } }).allow).toBe(true);
  });

  it("allows a whole input by variable", () => {
    const query = `mutation M($input: MarkPullRequestReadyForReviewInput!) { markPullRequestReadyForReview(input: $input) { clientMutationId } }`;
    expect(decide({ query, variables: { input: { pullRequestId: PR.nodeId } } }).allow).toBe(true);
  });

  const other = `mutation { markPullRequestReadyForReview(input: { pullRequestId: "PR_other" }) { clientMutationId } }`;
  it.each([
    ["another run's PR", { query: other }],
    ["another PR by variable", {
      query: `mutation M($id: ID!) { markPullRequestReadyForReview(input: { pullRequestId: $id }) { clientMutationId } }`,
      variables: { id: "PR_other" },
    }],
    ["an unset variable with a default", {
      query: `mutation M($id: ID = "PR_other") { markPullRequestReadyForReview(input: { pullRequestId: $id }) { clientMutationId } }`,
    }],
    ["a variable overriding a default that matches", {
      query: `mutation M($id: ID = "${PR.nodeId}") { markPullRequestReadyForReview(input: { pullRequestId: $id }) { clientMutationId } }`,
    }],
    ["a repeated input field", {
      query: `mutation { markPullRequestReadyForReview(input: { pullRequestId: "${PR.nodeId}", pullRequestId: "PR_other" }) { clientMutationId } }`,
    }],
    ["merging", {
      query: `mutation { mergePullRequest(input: { pullRequestId: "${PR.nodeId}" }) { clientMutationId } }`,
    }],
    ["a review", {
      query: `mutation { addPullRequestReview(input: { pullRequestId: "${PR.nodeId}", event: APPROVE }) { clientMutationId } }`,
    }],
    ["removing agent:stop", {
      query: `mutation { removeLabelsFromLabelable(input: { labelableId: "I_own", labelIds: ["LA_stop"] }) { clientMutationId } }`,
    }],
    ["adding a label", {
      query: `mutation { addLabelsToLabelable(input: { labelableId: "I_own", labelIds: ["LA_ready"] }) { clientMutationId } }`,
    }],
    ["closing a blocker", { query: `mutation { closeIssue(input: { issueId: "I_blocker" }) { clientMutationId } }` }],
    ["moving a ref", { query: `mutation { updateRef(input: { refId: "R_main", oid: "${NEW}", force: true }) { clientMutationId } }` }],
    ["a commit through the API", { query: `mutation { createCommitOnBranch(input: {}) { clientMutationId } }` }],
    ["an alias", {
      query: `mutation { ready: markPullRequestReadyForReview(input: { pullRequestId: "${PR.nodeId}" }) { clientMutationId } }`,
    }],
    ["two mutations", {
      query: `mutation { markPullRequestReadyForReview(input: { pullRequestId: "${PR.nodeId}" }) { clientMutationId } mergePullRequest(input: { pullRequestId: "${PR.nodeId}" }) { clientMutationId } }`,
    }],
    ["a fragment hiding a merge", {
      query: `mutation { ...F } fragment F on Mutation { mergePullRequest(input: { pullRequestId: "${PR.nodeId}" }) { clientMutationId } }`,
    }],
    ["an inline fragment", {
      query: `mutation { ... on Mutation { mergePullRequest(input: { pullRequestId: "${PR.nodeId}" }) { clientMutationId } } }`,
    }],
    ["a fragment beside an allowed mutation", {
      query: `${ready} fragment F on Mutation { mergePullRequest(input: { pullRequestId: "x" }) { clientMutationId } }`,
    }],
    ["a query and a mutation", { query: `query Q { viewer { login } } mutation M { mergePullRequest(input: {}) { clientMutationId } }`, operationName: "M" }],
    ["two queries", { query: "query A { viewer { login } } query B { viewer { id } }" }],
    ["a subscription", { query: "subscription { x }" }],
    ["a commit body on auto-merge", {
      query: `mutation { enablePullRequestAutoMerge(input: { pullRequestId: "${PR.nodeId}", commitBody: "Fixes #99" }) { clientMutationId } }`,
    }],
    ["a merge commit", {
      query: `mutation { enablePullRequestAutoMerge(input: { pullRequestId: "${PR.nodeId}", mergeMethod: MERGE }) { clientMutationId } }`,
    }],
    ["a directive", { query: `mutation { markPullRequestReadyForReview(input: { pullRequestId: "${PR.nodeId}" }) @skip(if: false) { clientMutationId } }` }],
    ["a batch", [{ query: "{ viewer { login } }" }]],
    ["a schema definition", { query: "type T { a: String }" }],
    ["an unknown field", { query: "{ viewer { login } }", extensions: {} }],
    ["no query", {}],
    ["bad syntax", { query: "mutation {" }],
    ["array variables", { query: ready, variables: [] }],
    ["an object method name", { query: `mutation { constructor(input: { pullRequestId: "${PR.nodeId}" }) { clientMutationId } }` }],
  ])("denies %s", (_name, body) => {
    expect(decide(body).allow).toBe(false);
  });

  it("denies every mutation before the run has a PR", () => {
    expect(decide({ query: ready }, noPins).allow).toBe(false);
  });

  it("denies a document with too many tokens", () => {
    const fields = "a ".repeat(6000);
    expect(decide({ query: `{ ${fields} }` }).allow).toBe(false);
  });

  it("forwards only the printed document and variables", () => {
    const verdict = decide({ query: "  query   Q { viewer { login } }  ", operationName: "Q" });
    expect(verdict.allow).toBe(true);
    const body = JSON.parse((verdict as { body: string }).body) as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual(["query", "variables"]);
    expect(body.query).toContain("query Q");
  });
});

describe("model calls", () => {
  const anthropic = MODEL_HOSTS["api.anthropic.com"]!;
  const openai = MODEL_HOSTS["api.openai.com"]!;
  const models = ["allowed-model", "unpriced-model"];
  const price = { input: 1, output: 2, cacheWrite5m: 1.25, cacheWrite1h: 2, cacheRead: 0.1 };
  const prices = { "allowed-model": price };
  const decide = (body: unknown, method = "POST", path = "/v1/messages", search = "") =>
    decideModel(anthropic, method, path, search, body, models, prices, 1000);
  const request = { model: "allowed-model", max_tokens: 10, messages: [{ role: "user", content: "Hi" }] };

  it("allows an allowed model on an allowed endpoint", () => {
    expect(decide(request).allow).toBe(true);
    expect(decide(request, "POST", "/v1/messages", "?beta=true").allow).toBe(true);
  });

  it("returns what to reserve against for a charged call, and nothing for a free one", () => {
    expect(decide(request)).toMatchObject({ allow: true, metering: { price, maxTokens: 10 } });
    const counted = decide({ model: "allowed-model", messages: [] }, "POST", "/v1/messages/count_tokens");
    expect(counted).toMatchObject({ allow: true, metering: null });
  });

  it("allows the standard settings of the fields that change the price", () => {
    expect(decide({ ...request, speed: "standard", inference_geo: "global", service_tier: "standard_only" }).allow).toBe(true);
  });

  it("denies a vendor whose usage the handler can't read", () => {
    expect(decideModel(openai, "POST", "/v1/responses", "", request, models, prices, 1000)).toEqual({
      allow: false,
      reason: "model: this vendor's calls aren't metered",
    });
  });

  it("allows tools the client runs", () => {
    const tools = [{ name: "a", input_schema: {} }, { type: "custom", name: "b" }, { type: "bash_20250124", name: "bash" }];
    expect(decide({ ...request, tools }).allow).toBe(true);
    expect(decide({ ...request, messages: [{ role: "user", content: [{ type: "image", source: { type: "base64", data: "x" } }] }] }).allow).toBe(true);
  });

  it.each([
    ["another model", { ...request, model: "other-model" }],
    ["no model", { max_tokens: 10 }],
    ["an MCP server the vendor would call", { ...request, mcp_servers: [{ url: "https://evil.example" }] }],
    ["a vendor container", { ...request, container: "abc" }],
    ["web search", { ...request, tools: [{ type: "web_search_20250305", name: "web_search" }] }],
    ["web fetch", { ...request, tools: [{ type: "web_fetch_20250910", name: "web_fetch" }] }],
    ["code execution", { ...request, tools: [{ type: "code_execution_20250825", name: "x" }] }],
    ["OpenAI MCP", { ...request, tools: [{ type: "mcp", server_url: "https://evil.example" }] }],
    ["an image the vendor would fetch", { ...request, messages: [{ role: "user", content: [{ type: "image", source: { type: "url", url: "https://evil.example/?d=secret" } }] }] }],
    ["an OpenAI image URL", { ...request, input: [{ role: "user", content: [{ type: "input_image", image_url: "https://evil.example/x.png" }] }] }],
    ["an OpenAI file URL", { ...request, input: [{ role: "user", content: [{ type: "input_file", file_url: "https://evil.example/x.pdf" }] }] }],
    ["a body that isn't an object", [request]],
    ["an allowed model with no price", { ...request, model: "unpriced-model" }],
    ["no max_tokens", { model: "allowed-model", messages: [] }],
    ["a max_tokens over the ceiling", { ...request, max_tokens: 1001 }],
    ["a max_tokens that isn't a whole number", { ...request, max_tokens: 10.5 }],
    ["fast mode", { ...request, speed: "fast" }],
    ["a pinned region", { ...request, inference_geo: "us" }],
    ["the priority tier", { ...request, service_tier: "auto" }],
  ])("denies %s", (_name, body) => {
    expect(decide(body).allow).toBe(false);
  });

  it.each([
    ["the files API", "POST", "/v1/files"],
    ["batches", "POST", "/v1/messages/batches"],
    ["listing models", "GET", "/v1/models"],
    ["a GET on messages", "GET", "/v1/messages"],
  ])("denies %s", (_name, method, path) => {
    expect(decide(request, method, path).allow).toBe(false);
  });

  it("denies an unexpected query", () => {
    expect(decide(request, "POST", "/v1/messages", "?x=1").allow).toBe(false);
  });

  it("allows nothing when no models are configured", () => {
    expect(decideModel(anthropic, "POST", "/v1/messages", "", request, [], prices, 1000).allow).toBe(false);
  });
});
