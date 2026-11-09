import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { AgentEvent, Access, AuthStatus, ModelOption, RunRequest } from '../types.js';
import { CliAdapter, DEFAULT_MODEL, isRecord, num, str, type BuiltInvocation, type Parser } from './base.js';
import { commandPreviews } from '../preview.js';

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
    const args = ['-p', '--output-format', 'stream-json', '--verbose', '--include-partial-messages', '--permission-mode', PERMISSION_MODE[req.access ?? 'read-only']];
    if (req.model) args.push('--model', req.model);
    if (req.effort) args.push('--effort', req.effort);
    if (req.sessionId) args.push('--resume', req.sessionId);
    if (req.systemPrompt) args.push('--append-system-prompt', req.systemPrompt);
    for (const dir of req.attachmentDirectories ?? []) args.push('--add-dir', dir);

    // Headless mode cannot ask for approval, so what a run may use is decided up front. Web tools are blocked by
    // default (the model would otherwise burn a turn trying one and being refused) and Chrome control is switched
    // off explicitly, because the CLI can be configured to start it on its own.
    const allowed: string[] = [];
    if (req.permissions?.web) allowed.push('WebSearch', 'WebFetch');
    else args.push('--disallowedTools', 'WebSearch,WebFetch');
    args.push(req.permissions?.browser ? '--chrome' : '--no-chrome');

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
      allowed.push(...req.mcpServers.map((s) => `mcp__${s.name}`));
    }
    if (allowed.length) args.push('--allowedTools', allowed.join(','));
    return { args, stdin: req.prompt, cleanup };
  }

  protected createParser(): Parser {
    let sessionSeen = false;
    let streamed = false;
    const agents = new Map<string, string>();
    const commandIds = new Set<string>();
    return (raw) => {
      if (!isRecord(raw)) return [];
      const events: AgentEvent[] = [];
      const type = str(raw.type);

      if (type === 'stream_event' && !raw.parent_tool_use_id && isRecord(raw.event)) {
        if (raw.event.type === 'message_start') streamed = false;
        const delta = raw.event.delta;
        if (raw.event.type === 'content_block_delta' && isRecord(delta) && delta.type === 'text_delta' && typeof delta.text === 'string') {
          streamed = true;
          events.push({ type: 'text', text: delta.text, partial: true });
        }
      } else if (type === 'system' && str(raw.subtype) === 'init') {
        const id = str(raw.session_id);
        if (id && !sessionSeen) {
          sessionSeen = true;
          events.push({ type: 'session', sessionId: id });
        }
      } else if (type === 'system' && raw.ambient !== true) {
        const taskId = str(raw.task_id), subtype = str(raw.subtype);
        if (taskId && subtype === 'task_started' && (raw.task_type === 'local_agent' || raw.task_type === 'remote_agent')) {
          agents.set(taskId, (str(raw.description) || 'Subagente').slice(0, 180));
        }
        const label = taskId && agents.get(taskId);
        if (taskId && label && (subtype === 'task_started' || subtype === 'task_progress' || subtype === 'task_notification')) {
          const status = subtype !== 'task_notification' ? 'running' : raw.status === 'completed' ? 'done' : raw.status === 'stopped' ? 'cancelled' : 'error';
          events.push({ type: 'subagent', agentId: taskId, label, status, detail: (str(raw.summary) ?? str(raw.last_tool_name))?.slice(0, 240) });
        }
      } else if ((type === 'assistant' || type === 'user') && !raw.parent_tool_use_id) {
        const content = isRecord(raw.message) && Array.isArray(raw.message.content) ? raw.message.content : [];
        for (const block of content) {
          if (!isRecord(block)) continue;
          const kind = str(block.type);
          if (type === 'assistant' && kind === 'text' && str(block.text) && !streamed) {
            events.push({ type: 'text', text: str(block.text)! });
          } else if (type === 'assistant' && kind === 'tool_use') {
            const name = str(block.name) ?? 'unknown', id = str(block.id);
            if (id && name === 'Bash') commandIds.add(id);
            if (name === 'AskUserQuestion' && isRecord(block.input) && Array.isArray(block.input.questions)) {
              const questions = block.input.questions.filter(isRecord).slice(0, 4);
              const prompts = questions.map((q) => str(q.question)?.trim()).filter(Boolean);
              const options = questions.length === 1 && Array.isArray(questions[0]?.options)
                ? questions[0].options.filter(isRecord).map((option) => str(option.label)?.slice(0, 200)).filter((value): value is string => !!value).slice(0, 6)
                : [];
              if (prompts.length) events.push({ type: 'question', question: prompts.join('\n\n').slice(0, 4000), options });
            }
            events.push({ type: 'tool_call', name, input: block.input });
          } else if (type === 'user' && kind === 'tool_result') {
            if (commandIds.delete(str(block.tool_use_id) ?? '') && !block.is_error) {
              const output = str(block.content) ?? (Array.isArray(block.content) ? block.content.filter(isRecord).map((part) => str(part.text) ?? '').join('\n') : '');
              for (const url of commandPreviews(output)) events.push({ type: 'preview', url });
            }
            events.push({ type: 'tool_result', isError: block.is_error === true });
          }
        }
        if (type === 'assistant') streamed = false;
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
        // Claude Code reports fresh input apart from what it wrote to and read from the prompt cache. All of it goes
        // through the model on every turn (the system prompt and tools alone are ~20k tokens), so count all of it:
        // "input_tokens" alone shows 3 for a turn that processed 23,000.
        const parts = [usage.input_tokens, usage.cache_creation_input_tokens, usage.cache_read_input_tokens].map(num);
        events.push({
          type: 'usage',
          inputTokens: parts.some((n) => n !== undefined) ? parts.reduce<number>((sum, n) => sum + (n ?? 0), 0) : undefined,
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
