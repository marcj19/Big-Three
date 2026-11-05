import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { AgentEvent, Access, AuthStatus, ModelOption, RunRequest } from '../types.js';
import { CliAdapter, DEFAULT_MODEL, isRecord, num, str, type BuiltInvocation, type Parser } from './base.js';

const PERMISSION_MODE: Record<Access, string> = {
  'read-only': 'plan',
  edit: 'acceptEdits',
  full: 'bypassPermissions',
};

export class ClaudeAdapter extends CliAdapter {
  readonly id = 'claude' as const;
  readonly displayName = 'Claude';
  readonly supportsResume = true;
  readonly supportsMcp = true;
  protected readonly binaryName = 'claude';
  protected readonly installHint = 'Install Claude Code and sign in with your subscription.';
  // --claudeai: sign in with the subscription, never the pay-per-token Console.
  protected override readonly loginArgs = ['auth', 'login', '--claudeai'];
  override readonly efforts = ['low', 'medium', 'high', 'xhigh', 'max'] as const;

  /**
   * The CLI has no command to list models, so this is a fixed list: aliases always follow the newest model of a
   * family, full names pin one. Which of them an account may use depends on its plan; the CLI reports it if not.
   */
  override async listModels(): Promise<ModelOption[]> {
    return [
      DEFAULT_MODEL,
      { id: 'opus', label: 'Opus', note: 'o mais recente' },
      { id: 'sonnet', label: 'Sonnet', note: 'o mais recente' },
      { id: 'haiku', label: 'Haiku', note: 'o mais recente' },
      { id: 'claude-opus-5-5', label: 'Opus 5.5' },
      { id: 'claude-sonnet-5-5', label: 'Sonnet 5.5' },
      { id: 'claude-haiku-5-5', label: 'Haiku 5.5' },
      { id: 'claude-fable-5-1', label: 'Fable 5.1' },
    ];
  }

  protected override async checkAuth(): Promise<AuthStatus> {
    const { lines } = await this.capture(['auth', 'status']);
    try {
      const status = JSON.parse(lines.join('\n')) as { loggedIn?: boolean; authMethod?: string };
      return { signedIn: status.loggedIn === true, detail: status.authMethod };
    } catch {
      return { signedIn: 'unknown' };
    }
  }

  protected async build(req: RunRequest): Promise<BuiltInvocation> {
    const args = ['-p', '--output-format', 'stream-json', '--verbose', '--permission-mode', PERMISSION_MODE[req.access ?? 'read-only']];
    if (req.model) args.push('--model', req.model);
    if (req.effort) args.push('--effort', req.effort);
    if (req.sessionId) args.push('--resume', req.sessionId);
    if (req.systemPrompt) args.push('--append-system-prompt', req.systemPrompt);

    let cleanup: BuiltInvocation['cleanup'];
    if (req.mcpServers?.length) {
      const dir = await mkdtemp(path.join(os.tmpdir(), 'aio-claude-'));
      const file = path.join(dir, 'mcp.json');
      const mcpServers = Object.fromEntries(
        req.mcpServers.map((s) => [s.name, { command: s.command, args: s.args ?? [], env: s.env ?? {} }]),
      );
      await writeFile(file, JSON.stringify({ mcpServers }));
      cleanup = () => rm(dir, { recursive: true, force: true });
      // --strict-mcp-config: ignore any other MCP servers the user has configured globally.
      args.push('--mcp-config', file, '--strict-mcp-config');
      // Headless mode cannot ask for approval, so pre-approve exactly these servers' tools.
      args.push('--allowedTools', req.mcpServers.map((s) => `mcp__${s.name}`).join(','));
    }
    return { args, stdin: req.prompt, cleanup };
  }

  protected createParser(): Parser {
    let sessionSeen = false;
    return (raw) => {
      if (!isRecord(raw)) return [];
      const events: AgentEvent[] = [];
      const type = str(raw.type);

      if (type === 'system' && str(raw.subtype) === 'init') {
        const id = str(raw.session_id);
        if (id && !sessionSeen) {
          sessionSeen = true;
          events.push({ type: 'session', sessionId: id });
        }
      } else if (type === 'assistant' || type === 'user') {
        const content = isRecord(raw.message) && Array.isArray(raw.message.content) ? raw.message.content : [];
        for (const block of content) {
          if (!isRecord(block)) continue;
          const kind = str(block.type);
          if (type === 'assistant' && kind === 'text' && str(block.text)) {
            events.push({ type: 'text', text: str(block.text)! });
          } else if (type === 'assistant' && kind === 'tool_use') {
            events.push({ type: 'tool_call', name: str(block.name) ?? 'unknown', input: block.input });
          } else if (type === 'user' && kind === 'tool_result') {
            events.push({ type: 'tool_result', isError: block.is_error === true });
          }
        }
      } else if (type === 'rate_limit_event') {
        // Observed live: { status: "allowed", resetsAt: <epoch seconds>, rateLimitType: "five_hour" }.
        const info = isRecord(raw.rate_limit_info) ? raw.rate_limit_info : {};
        const status = str(info.status);
        const resetsAt = num(info.resetsAt);
        const utilization = num(info.utilization);
        if (status) events.push({ type: 'limit', status, window: str(info.rateLimitType), resetsAt: resetsAt === undefined ? undefined : resetsAt * 1000,
          ...(utilization !== undefined && utilization >= 0 && utilization <= 1 ? { usedPercent: utilization * 100 } : {}) });
      } else if (type === 'result') {
        const usage = isRecord(raw.usage) ? raw.usage : {};
        events.push({
          type: 'usage',
          inputTokens: num(usage.input_tokens),
          outputTokens: num(usage.output_tokens),
          costUsd: num(raw.total_cost_usd),
        });
        const isError = raw.is_error === true;
        const text = str(raw.result);
        if (isError) events.push({ type: 'error', message: text ?? str(raw.subtype) ?? 'Claude reported an error' });
        events.push({ type: 'done', status: isError ? 'error' : 'ok', text });
      }
      return events;
    };
  }
}
