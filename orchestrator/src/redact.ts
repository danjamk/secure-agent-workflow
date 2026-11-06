/**
 * Removes credentials from text that came out of a run's container, before it's
 * stored or posted (#10, red-team scenario 9). Two layers: the exact value of every
 * credential the Worker holds, then patterns for common token formats, which catch
 * the ones it doesn't hold.
 */

export const REMOVED = "[removed]";

/**
 * Formats of tokens and keys, whoever issued them. `eC1hY2Nlc3MtdG9rZW46` is
 * "x-access-token:" in base64, how git sends a token as Basic auth.
 */
const PATTERNS =
  /gh[opsur]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|sk-ant-[A-Za-z0-9_-]{10,}|sk-[A-Za-z0-9_-]{20,}|x-access-token:[^\s@"]+|eC1hY2Nlc3MtdG9rZW46[A-Za-z0-9+/]+=*|(?<=[Bb]asic )[A-Za-z0-9+/]{16,}=*|AKIA[0-9A-Z]{16}|eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}|-----BEGIN[^-]*PRIVATE KEY-----[\s\S]*?(?:-----END[^-]*PRIVATE KEY-----|$)/g;

/** Shorter values would match ordinary text. */
const MIN_SECRET = 8;

/**
 * Every credential the Worker holds, plus the run's tokens. A PEM key is also listed
 * line by line, so part of one is still removed.
 */
export function credentialValues(env: Env, tokens: string[] = []): string[] {
  const values: string[] = [...tokens];
  // A git client sends the token as Basic auth, so its encoded form counts too.
  for (const token of tokens) values.push(btoa(`x-access-token:${token}`));
  for (const name of ["GITHUB_APP_PRIVATE_KEY", "GITHUB_WEBHOOK_SECRET", "ANTHROPIC_API_KEY", "OPENAI_API_KEY"] as const) {
    const value = env[name];
    if (!value) continue;
    values.push(value.trim());
    if (name === "GITHUB_APP_PRIVATE_KEY") {
      for (const line of value.split(/\r?\n/)) {
        if (!line.startsWith("-----")) values.push(line.trim());
      }
    }
  }
  return [...new Set(values.filter((value) => value.length >= MIN_SECRET))];
}

/**
 * The text with each secret removed, as it is and as JSON escapes it, since the
 * agent's output is JSON. Longer values go first, so a whole key goes before its lines.
 */
export function redact(text: string, secrets: string[]): { text: string; count: number } {
  let count = 0;
  const forms = new Set<string>();
  for (const secret of secrets) {
    forms.add(secret);
    forms.add(JSON.stringify(secret).slice(1, -1));
  }
  for (const form of [...forms].sort((a, b) => b.length - a.length)) {
    if (form.length < MIN_SECRET || !text.includes(form)) continue;
    const parts = text.split(form);
    count += parts.length - 1;
    text = parts.join(REMOVED);
  }
  text = text.replace(PATTERNS, () => {
    count += 1;
    return REMOVED;
  });
  return { text, count };
}
