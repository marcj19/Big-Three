import type { AgentEvent, Access, AuthStatus, ModelOption, RunRequest } from '../types.js';
import { CliAdapter, DEFAULT_MODEL, isRecord, num, str, type BuiltInvocation, type Parser } from './base.js';

const SANDBOX: Record<Access, string> = {
  'read-only': 'read-only',
  edit: 'workspace-write',
  full: 'danger-full-access',
};

/** TOML basic strings accept the same escapes JSON.stringify produces, so it is safe to reuse for -c values. */
const toml = (v: string | string[]) => JSON.stringify(v);
/** An inline TOML table of strings: `{ KEY = "value" }`. Keys are quoted unless they are plain identifiers. */
const tomlTable = (env: Record<string, string>) =>
  `{${Object.entries(env)
    .map(([k, v]) => `${/^[A-Za-z0-9_-]+$/.test(k) ? k : JSON.stringify(k)} = ${JSON.stringify(v)}`)
    .join(', ')}}`;

/**
 * NOTE: written from Codex's documented `exec --json` event stream and covered by fixture tests only;
 * Codex is not installed on this machine yet, so it has not been exercised against the real CLI.
 */
export class CodexAdapter extends CliAdapter {
  readonly id = 'codex' as const;
  readonly displayName = 'Codex';
  readonly supportsResume = true;
  readonly supportsMcp = true;
  protected readonly binaryName = 'codex';
  protected readonly installHint = 'Install with `npm i -g @openai/codex` and sign in with your ChatGPT account.';
  protected override readonly loginArgs = ['login'];
  override readonly efforts = ['low', 'medium', 'high'] as const;

  /** Codex has no model-listing command; leave the account default and let the picker take a typed name. */
  override async listModels(): Promise<ModelOption[]> {
    return [DEFAULT_MODEL];
  }

  protected override async checkAuth(): Promise<AuthStatus> {
    // `codex login status` exits 0 only when signed in (per the Codex docs; unverified here).
    const { code } = await this.capture(['login', 'status']);
    return code === null ? { signedIn: 'unknown' } : { signedIn: code === 0 };
  }

  protected build(req: RunRequest): BuiltInvocation {
    const args = ['exec'];
    const sandbox = SANDBOX[req.access ?? 'read-only'];
    if (req.sessionId) {
      // `exec resume` has no --sandbox flag; the same setting goes in as a config override.
      args.push('resume', req.sessionId, '--json', '--skip-git-repo-check', '-c', `sandbox_mode=${toml(sandbox)}`);
    } else {
      args.push('--json', '--skip-git-repo-check', '--sandbox', sandbox);
    }
    if (req.model) args.push('--model', req.model);
    if (req.effort) args.push('-c', `model_reasoning_effort=${toml(req.effort)}`);
    for (const s of req.mcpServers ?? []) {
      if (!/^[A-Za-z0-9_-]+$/.test(s.name)) throw new Error(`Invalid MCP server name: ${s.name.slice(0, 30)}`);
      args.push('-c', `mcp_servers.${s.name}.command=${toml(s.command)}`);
      args.push('-c', `mcp_servers.${s.name}.args=${toml(s.args ?? [])}`);
      // Without its env the room and database servers cannot even start: they are configured through it.
      if (s.env && Object.keys(s.env).length) args.push('-c', `mcp_servers.${s.name}.env=${tomlTable(s.env)}`);
      // Codex gives up on a tool after 60 s by default, and asking a colleague can take longer than that.
      args.push('-c', `mcp_servers.${s.name}.tool_timeout_sec=240`, '-c', `mcp_servers.${s.name}.startup_timeout_sec=30`);
      // Headless runs cannot ask for approval, so the tools of exactly these servers are pre-approved
      // (the same decision the Claude adapter makes with --allowedTools).
      args.push('-c', `mcp_servers.${s.name}.default_tools_approval_mode="approve"`);
    }
    args.push('-'); // read the prompt from stdin
    const stdin = req.systemPrompt ? `${req.systemPrompt}\n\n${req.prompt}` : req.prompt;
    return { args, stdin };
  }

  protected createParser(): Parser {
    let lastMessage = '';
    return (raw) => {
      if (!isRecord(raw)) return [];
      const events: AgentEvent[] = [];
      switch (str(raw.type)) {
        case 'thread.started': {
          const id = str(raw.thread_id);
          if (id) events.push({ type: 'session', sessionId: id });
          break;
        }
        case 'item.started': {
          const item = isRecord(raw.item) ? raw.item : {};
          if (str(item.type) === 'command_execution') events.push({ type: 'tool_call', name: 'shell', input: item.command });
          else if (str(item.type) === 'mcp_tool_call') events.push({ type: 'tool_call', name: `${str(item.server) ?? 'mcp'}.${str(item.tool) ?? 'tool'}`, input: item.arguments });
          break;
        }
        case 'item.completed': {
          const item = isRecord(raw.item) ? raw.item : {};
          const kind = str(item.type);
          if (kind === 'agent_message' && str(item.text)) {
            lastMessage = str(item.text)!;
            events.push({ type: 'text', text: lastMessage });
          } else if (kind === 'command_execution') {
            events.push({ type: 'tool_result', name: 'shell', isError: typeof item.exit_code === 'number' && item.exit_code !== 0 });
          } else if (kind === 'mcp_tool_call') {
            events.push({ type: 'tool_result', name: `${str(item.server) ?? 'mcp'}.${str(item.tool) ?? 'tool'}`, isError: str(item.status) === 'failed' });
          }
          break;
        }
        case 'turn.completed': {
          const usage = isRecord(raw.usage) ? raw.usage : {};
          events.push({ type: 'usage', inputTokens: num(usage.input_tokens), outputTokens: num(usage.output_tokens) });
          events.push({ type: 'done', status: 'ok', text: lastMessage || undefined });
          break;
        }
        case 'turn.failed': {
          const err = isRecord(raw.error) ? raw.error : {};
          events.push({ type: 'error', message: str(err.message) ?? 'Codex turn failed' });
          events.push({ type: 'done', status: 'error' });
          break;
        }
        case 'error':
          events.push({ type: 'error', message: str(raw.message) ?? 'Codex reported an error' });
          break;
      }
      return events;
    };
  }
}
