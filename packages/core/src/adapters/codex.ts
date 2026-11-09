import type { AgentEvent, Access, AuthStatus, ModelOption, RunRequest } from '../types.js';
import { assertSafeChoice, CliAdapter, isRecord, num, str, type BuiltInvocation, type Parser } from './base.js';
import { readCodexAppServer } from '../codex-app-server.js';
import { readCodexQuota } from '../codex-quota.js';
import { commandPreviews } from '../preview.js';

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
  async readQuota() { return readCodexQuota(await this.command(), this.env()); }
  readonly id = 'codex' as const;
  readonly displayName = 'Codex';
  readonly supportsResume = true;
  readonly supportsMcp = true;
  protected readonly binaryName = 'codex';
  protected readonly installHint = 'Install with `npm i -g @openai/codex` and sign in with your ChatGPT account.';
  protected override readonly loginArgs = ['login'];
  override readonly efforts = ['low', 'medium', 'high'] as const;

  /** Use the same catalog as the CLI picker, and leave an option to use the CLI configuration as-is. */
  override async listModels(): Promise<ModelOption[]> {
    const automatic = { id: '', label: 'Automático (padrão do Codex)' };
    try {
      const pages = await readCodexAppServer(await this.command(), this.env(), 'model/list');
      const models = new Map<string, ModelOption>();
      for (const page of pages) {
        if (!isRecord(page) || !Array.isArray(page.data)) continue;
        for (const model of page.data) {
          if (!isRecord(model) || model.hidden === true) continue;
          const id = str(model.model) ?? str(model.id);
          if (!id || models.has(id)) continue;
          try { assertSafeChoice({ model: id }); } catch { continue; }
          models.set(id, { id, label: str(model.displayName)?.trim().slice(0, 100) || id });
        }
      }
      return [automatic, ...models.values()];
    } catch {
      return [automatic];
    }
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
    // Codex searches the web on its own unless told otherwise, so "not granted" has to say "disabled".
    args.push('-c', `web_search=${toml(req.permissions?.web ? 'live' : 'disabled')}`);
    // The ChatGPT "apps" (connectors) are a second way out: they brought their own web search, and they act on the
    // person's linked accounts. No permission in this app covers them, so they stay off.
    args.push('-c', 'features.apps=false');
    for (const image of req.attachmentImages ?? []) args.push('--image', image);
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
    const startedItems = new Set<string>();
    return (raw) => {
      if (!isRecord(raw)) return [];
      const events: AgentEvent[] = [];
      const item = isRecord(raw.item) ? raw.item : {};
      if ((raw.type === 'item.started' || raw.type === 'item.updated' || raw.type === 'item.completed') && item.type === 'collab_tool_call' && isRecord(item.agents_states)) {
        for (const [agentId, agent] of Object.entries(item.agents_states)) {
          if (!isRecord(agent)) continue;
          const state = str(agent.status);
          const status = state === 'completed' ? 'done' : state === 'errored' ? 'error'
            : state === 'shutdown' || state === 'interrupted' ? 'cancelled'
              : state === 'running' || state === 'pending_init' ? 'running' : undefined;
          if (status) events.push({ type: 'subagent', agentId, label: 'Subagente do Codex', status,
            detail: item.tool === 'spawn_agent' ? str(item.prompt)?.slice(0, 240) : undefined });
        }
      }
      if ((raw.type === 'item.updated' || raw.type === 'item.completed') && item.type === 'command_execution' && (item.exit_code == null || item.exit_code === 0)) {
        for (const url of commandPreviews(str(item.aggregated_output) ?? '')) events.push({ type: 'preview', url });
      }
      switch (str(raw.type)) {
        case 'thread.started': {
          const id = str(raw.thread_id);
          if (id) events.push({ type: 'session', sessionId: id });
          break;
        }
        case 'item.started': {
          if (str(item.type) === 'command_execution') events.push({ type: 'tool_call', name: 'shell', input: item.command });
          else if (str(item.type) === 'file_change' || str(item.type) === 'web_search') {
            if (str(item.id)) startedItems.add(str(item.id)!);
            events.push({ type: 'tool_call', name: str(item.type) === 'file_change' ? 'apply_patch' : 'web_search' });
          }
          else if (str(item.type) === 'mcp_tool_call') events.push({ type: 'tool_call', name: `${str(item.server) ?? 'mcp'}.${str(item.tool) ?? 'tool'}`, input: item.arguments });
          break;
        }
        case 'item.completed': {
          const kind = str(item.type);
          if (kind === 'agent_message' && str(item.text)) {
            lastMessage = str(item.text)!;
            events.push({ type: 'text', text: lastMessage });
          } else if (kind === 'command_execution') {
            const exitCode = num(item.exit_code);
            events.push({ type: 'tool_result', name: 'shell', isError: !!exitCode, ...(exitCode ? { exitCode } : {}) });
          } else if (kind === 'file_change') {
            // Some CLI versions only announce file changes once the patch has finished.
            if (!startedItems.delete(str(item.id) ?? '')) events.push({ type: 'tool_call', name: 'apply_patch' });
            events.push({ type: 'tool_result', name: 'apply_patch', isError: str(item.status) === 'failed' });
          } else if (kind === 'web_search') {
            if (!startedItems.delete(str(item.id) ?? '')) events.push({ type: 'tool_call', name: 'web_search' });
            events.push({ type: 'tool_result', name: 'web_search' });
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
