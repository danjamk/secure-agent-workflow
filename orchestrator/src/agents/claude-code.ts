import instructions from "../../../standards/agent-instructions.md";
import decisionLog from "../../../standards/decision-log.md";
import { caEnv } from "../sandbox";
import type { Runner } from "./index";

/** The main model and the one Claude Code uses for background work. Both must be in ALLOWED_MODELS. */
export const MODEL = "claude-sonnet-5-5";
export const BACKGROUND_MODEL = "claude-haiku-5-5";

export const MAX_TURNS = 200;
/** Claude Code's own estimate, so it's a soft cap. The workspace spend limit is the hard one. */
export const MAX_BUDGET_USD = 5;

/** The agent App's bot account, so commits show as the App's (`GET /users/<slug>[bot]`). */
const BOT_NAME = "danjamk-build-agent[bot]";
const BOT_EMAIL = "350445043+danjamk-build-agent[bot]@users.noreply.github.com";

const TASK = "/workspace/task";
const MAX_ISSUE_BODY = 60_000;

interface ResultEvent {
  is_error?: boolean;
  subtype?: string;
  result?: string;
  num_turns?: number;
  total_cost_usd?: number;
}

/** Claude Code, run headless as the agent user (#9). */
export const claudeCode: Runner = {
  name: "claude-code",
  instance: "standard-1",
  limitMs: 60 * 60 * 1000,

  files({ scope, issue, resume }) {
    const cut = (text: string) => (text.length > MAX_ISSUE_BODY ? `${text.slice(0, MAX_ISSUE_BODY)}\n\n[cut]` : text);
    const files: Record<string, string> = {
      [`${TASK}/issue.md`]: `# #${scope.issue}: ${issue.title}\n\n${cut(issue.body)}\n`,
      [`${TASK}/agent-instructions.md`]: instructions,
      [`${TASK}/decision-log.md`]: decisionLog,
    };
    if (resume) files[`${TASK}/reply.md`] = `${cut(resume.reply)}\n`;
    return files;
  },

  command({ scope, resume }) {
    return {
      script: "/agent/run-agent.sh",
      user: "1001:1001",
      env: {
        REPO: scope.repo,
        ISSUE: String(scope.issue),
        DEFAULT_BRANCH: scope.defaultBranch,
        BOT_NAME,
        BOT_EMAIL,
        MODEL,
        MAX_TURNS: String(MAX_TURNS),
        MAX_BUDGET_USD: String(MAX_BUDGET_USD),
        RESUMED: resume ? "1" : "",
        RESUME_BRANCH: resume?.branch ?? "",
        RESUME_PR: resume?.pr ? String(resume.pr) : "",
        HOME: "/home/agent",
        // A placeholder: Claude Code won't start without a key, and the Worker
        // replaces it on the way out.
        ANTHROPIC_API_KEY: "provided-by-the-worker",
        ANTHROPIC_DEFAULT_HAIKU_MODEL: BACKGROUND_MODEL,
        // Each of these would try a host the container can't reach.
        CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
        DISABLE_TELEMETRY: "1",
        DISABLE_ERROR_REPORTING: "1",
        DISABLE_AUTOUPDATER: "1",
        DISABLE_FEEDBACK_COMMAND: "1",
        CLAUDE_CODE_DISABLE_FEEDBACK_SURVEY: "1",
        CLAUDE_CODE_DISABLE_OFFICIAL_MARKETPLACE_AUTOINSTALL: "1",
        ...caEnv(),
      },
    };
  },

  async report(exitCode, log, read) {
    let result: ResultEvent | null = null;
    try {
      const text = (await read(`${TASK}/result.json`)).trim();
      result = text ? (JSON.parse(text) as ResultEvent) : null;
    } catch {
      result = null;
    }
    if (!result) {
      return { summary: `The agent ended without a result (exit ${exitCode}).`, output: log };
    }
    const cost = typeof result.total_cost_usd === "number" ? `, about $${result.total_cost_usd.toFixed(2)}` : "";
    const turns = typeof result.num_turns === "number" ? `${result.num_turns} turns` : "unknown turns";
    if (result.is_error || exitCode !== "0") {
      return {
        summary: `The agent failed (${result.subtype ?? "error"}, ${turns}${cost}).`,
        output: result.result ?? log,
      };
    }
    return { summary: `The agent finished (${turns}${cost}).`, output: result.result ?? "" };
  },
};
