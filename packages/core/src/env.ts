const SENSITIVE_NAME = /(^|_)(PASSWORD|PASSWD|SECRET|TOKEN|API_?KEY|PRIVATE_?KEY|CREDENTIALS?)($|_)/i;
const SENSITIVE_PREFIX = /^(AIO_|DATABASE_URL$|PG(PASSWORD|USER|HOST)$|MYSQL_|ORACLE_)/i;
/**
 * State injected by a *parent* Claude Code / Agent SDK session (e.g. CLAUDE_CODE_SIMPLE switches the child into a
 * mode that ignores the subscription login, ANTHROPIC_BASE_URL redirects it). A child CLI must start clean.
 */
const PARENT_SESSION = /^(CLAUDECODE$|CLAUDE_CODE_|CLAUDE_AGENT_SDK_|CLAUDE_PID$|CLAUDE_EFFORT$|CLAUDE_PREVIEW_|ANTHROPIC_BASE_URL$|USE_(LOCAL|STAGING)_OAUTH$)/i;

export interface SanitizeOptions {
  /** Variable names to keep even though they look sensitive (case-insensitive). */
  passthrough?: string[];
  /** Variables to add after filtering. */
  extra?: Record<string, string>;
}

/**
 * Environment for a model CLI process. Drops anything that looks like a credential so a model with a
 * shell tool cannot read it with `env`. This also removes ANTHROPIC_API_KEY / OPENAI_API_KEY /
 * GEMINI_API_KEY, which is deliberate: if one were set, the CLI would bill that API key instead of
 * using the subscription login.
 */
export function sanitizeEnv(base: NodeJS.ProcessEnv = process.env, opts: SanitizeOptions = {}): NodeJS.ProcessEnv {
  const keep = new Set((opts.passthrough ?? []).map((n) => n.toUpperCase()));
  const out: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(base)) {
    if (value === undefined) continue;
    const sensitive = SENSITIVE_NAME.test(name) || SENSITIVE_PREFIX.test(name) || PARENT_SESSION.test(name);
    if (sensitive && !keep.has(name.toUpperCase())) continue;
    out[name] = value;
  }
  return { ...out, ...opts.extra };
}
