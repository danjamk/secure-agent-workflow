/**
 * Model spend (#92): prices, the worst-case cost reserved before a call, and the
 * actual cost read from the response. Amounts are in micro-dollars, so a price in
 * dollars per million tokens times a token count is the amount, with no rounding
 * until the end.
 */

/** Dollars per million tokens. */
export interface Price {
  input: number;
  output: number;
  cacheWrite5m: number;
  cacheWrite1h: number;
  cacheRead: number;
}

export interface Limits {
  /** Micro-dollars. A run, a release of an issue with its resumes, and a UTC calendar month. */
  run: number;
  issue: number;
  month: number;
  /** The largest max_tokens a call may ask for. */
  maxOutputTokens: number;
}

/** What a response's usage reports, as tokens. */
export interface Tokens {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite5m: number;
  cacheWrite1h: number;
}

const PRICE_FIELDS = ["input", "output", "cacheWrite5m", "cacheWrite1h", "cacheRead"] as const;

/** The price map. A model whose entry is incomplete has no price, so its calls are refused. */
export function parsePrices(json: string | undefined): Record<string, Price> {
  let all: unknown;
  try {
    all = JSON.parse(json ?? "{}");
  } catch {
    console.error("MODEL_PRICES isn't valid JSON, so every model call is refused");
    return {};
  }
  const prices: Record<string, Price> = {};
  if (typeof all !== "object" || all === null || Array.isArray(all)) return prices;
  for (const [model, entry] of Object.entries(all)) {
    const price = entry as Record<string, unknown> | null;
    const valid = PRICE_FIELDS.every((field) => {
      const value = price?.[field];
      return typeof value === "number" && Number.isFinite(value) && value >= 0;
    });
    if (valid) prices[model] = price as unknown as Price;
  }
  return prices;
}

/** A setting that isn't a non-negative number is 0, which refuses every call. */
function amount(value: string | undefined, scale: number): number {
  const number = Number(value);
  return value !== undefined && value.trim() !== "" && Number.isFinite(number) && number >= 0
    ? Math.floor(number * scale)
    : 0;
}

export function limits(env: Env): Limits {
  return {
    run: amount(env.RUN_BUDGET_USD, 1e6),
    issue: amount(env.ISSUE_BUDGET_USD, 1e6),
    month: amount(env.MONTHLY_BUDGET_USD, 1e6),
    maxOutputTokens: amount(env.MAX_OUTPUT_TOKENS, 1),
  };
}

/**
 * The most a call can cost. A token is at least one byte of the request, so the
 * body's length bounds its input tokens, priced at the dearest input rate. Images are
 * billed by size in pixels, which is fewer tokens than their base64 bytes.
 */
export function worstCase(price: Price, bodyBytes: number, maxTokens: number): number {
  const inputRate = Math.max(price.input, price.cacheWrite5m, price.cacheWrite1h);
  return Math.ceil(bodyBytes * inputRate + maxTokens * price.output);
}

export function costOf(price: Price, tokens: Tokens): number {
  return Math.ceil(
    tokens.input * price.input +
      tokens.output * price.output +
      tokens.cacheRead * price.cacheRead +
      tokens.cacheWrite5m * price.cacheWrite5m +
      tokens.cacheWrite1h * price.cacheWrite1h,
  );
}

function count(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : null;
}

/**
 * Anthropic's usage object, as tokens. Null if it's missing a count. Cache writes with
 * no breakdown by lifetime are counted at the 1-hour rate, the dearer one.
 */
export function readUsage(usage: unknown): Tokens | null {
  if (typeof usage !== "object" || usage === null) return null;
  const u = usage as Record<string, unknown>;
  const input = count(u.input_tokens);
  const output = count(u.output_tokens);
  if (input === null || output === null) return null;
  const written = count(u.cache_creation_input_tokens) ?? 0;
  const breakdown = (u.cache_creation ?? null) as Record<string, unknown> | null;
  const fiveMinutes = count(breakdown?.ephemeral_5m_input_tokens);
  const oneHour = count(breakdown?.ephemeral_1h_input_tokens);
  const split = fiveMinutes !== null && oneHour !== null && fiveMinutes + oneHour === written;
  return {
    input,
    output,
    cacheRead: count(u.cache_read_input_tokens) ?? 0,
    cacheWrite5m: split ? fiveMinutes : 0,
    cacheWrite1h: split ? oneHour : written,
  };
}

/**
 * Reads usage from a streamed response as it passes through. message_start carries
 * the input counts and message_delta the running totals, and the last one wins. The
 * usage counts only if the stream reached message_stop.
 */
export class StreamUsage {
  private pending = "";
  private decoder = new TextDecoder();
  private usage: Record<string, unknown> = {};
  private stopped = false;
  private failed = false;

  push(chunk: Uint8Array): void {
    this.pending += this.decoder.decode(chunk, { stream: true });
    // Events are separated by a blank line. Only whole lines are read.
    let newline = this.pending.indexOf("\n");
    while (newline !== -1) {
      this.line(this.pending.slice(0, newline).replace(/\r$/, ""));
      this.pending = this.pending.slice(newline + 1);
      newline = this.pending.indexOf("\n");
    }
  }

  private line(line: string): void {
    if (!line.startsWith("data:")) return;
    let event: Record<string, unknown>;
    try {
      event = JSON.parse(line.slice(5).trim()) as Record<string, unknown>;
    } catch {
      return;
    }
    if (event.type === "message_start") {
      const message = event.message as { usage?: Record<string, unknown> } | undefined;
      Object.assign(this.usage, message?.usage ?? {});
    } else if (event.type === "message_delta") {
      Object.assign(this.usage, (event.usage as Record<string, unknown> | undefined) ?? {});
    } else if (event.type === "message_stop") {
      this.stopped = true;
    } else if (event.type === "error") {
      this.failed = true;
    }
  }

  /** The stream's usage, or null if it didn't finish cleanly. */
  result(): Tokens | null {
    if (!this.stopped || this.failed) return null;
    return readUsage(this.usage);
  }
}

/** For the status comment. */
export function dollars(micros: number): string {
  return `$${(micros / 1e6).toFixed(2)}`;
}
