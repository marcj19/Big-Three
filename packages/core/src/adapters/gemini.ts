import os from 'node:os';
import path from 'node:path';
import type { AgentEvent, Access, AuthStatus, ModelOption, RunRequest } from '../types.js';
import { CliAdapter, DEFAULT_MODEL, isRecord, num, str, type BuiltInvocation, type Parser } from './base.js';
import { commandPreviews } from '../preview.js';

const ACCESS_ARGS: Record<Access, string[]> = {
  'read-only': ['--mode', 'plan'],
  edit: ['--mode', 'accept-edits'],
  // Auto can silently fall back to interactive review. Full access was already granted by the caller.
  full: ['--mode', 'accept-edits', '--dangerously-skip-permissions'],
};

export function parseAgyModels(lines: string[]): ModelOption[] {
  const models: ModelOption[] = [];
  for (const line of lines) {
    const [id, ...rest] = line.split('\t');
    // Lines without a tab are progress messages ("Fetching available models...").
    if (!id || rest.length === 0 || !/^[A-Za-z0-9][A-Za-z0-9._:/-]*$/.test(id.trim())) continue;
    models.push({ id: id.trim(), label: rest.join('\t').trim() || id.trim() });
  }
  return models;
}

/** The whole command line must stay under Windows' ~32k limit; the prompt is passed as an argument (see below). */
const MAX_PROMPT_CHARS = 24_000;

/**
 * Gemini through the Antigravity CLI (`agy`). The standalone Gemini CLI now rejects personal Google accounts
 * ("migrate to the Antigravity suite"), so this is the supported route.
 *
 * `agy -p` only accepts the prompt attached to the flag (`-p=<prompt>`), so the prompt travels in argv rather
 * than stdin. The process is spawned without a shell, so its contents are never interpreted as commands.
 *
 * Verified live: plain answers and a tool step. `--mode plan` kept the workspace untouched (the agent only wrote
 * its own plan document under ~/.gemini/antigravity-cli/brain). Error and permission-denied steps are not observed yet.
 */
export class GeminiAdapter extends CliAdapter {
  readonly id = 'gemini' as const;
  readonly displayName = 'Gemini (Antigravity)';
  readonly supportsResume = true;
  readonly supportsMcp = false;
  protected readonly binaryName = 'agy';
  protected readonly installHint = 'Instale a CLI do Antigravity (comando agy) e entre com sua conta Google.';
  protected override readonly extraSearchDirs = [
    ...(process.platform === 'win32' ? [
      path.join(process.env.LOCALAPPDATA ?? path.join(os.homedir(), 'AppData', 'Local'), 'agy', 'bin'),
      ...(process.env.ProgramFiles ? [path.join(process.env.ProgramFiles, 'Google', 'antigravity-cli')] : []),
    ] : []),
    path.join(os.homedir(), '.gemini', 'bin'),
  ];
  protected override readonly loginHelp = 'Open a terminal, run `agy` once and sign in with your Google account (or sign in through the Antigravity IDE).';

  /**
   * `agy models` prints one `id<TAB>label` per line (after a progress line) and costs no quota. The list is the
   * Antigravity subscription's own, so it can include models from other vendors; the reasoning level is part of the id.
   */
  override async listModels(): Promise<ModelOption[]> {
    const { lines, code } = await this.capture(['models']);
    return [DEFAULT_MODEL, ...(code === 0 ? parseAgyModels(lines) : [])];
  }

  protected override async checkAuth(): Promise<AuthStatus> {
    // `agy models` needs a valid session but does not run a model, so it costs no quota.
    const { code, lines, stderr } = await this.capture(['models']);
    if (code === 0) return { signedIn: true, detail: 'google' };
    const output = [...lines, stderr ?? ''].join('\n');
    if (/not (?:logged|signed) in|(?:authentication|login|sign-in) (?:is )?required|please (?:log|sign) in|\bunauthorized\b|\b401\b/i.test(output)) {
      return { signedIn: false };
    }
    return { signedIn: 'unknown' };
  }

  protected build(req: RunRequest): BuiltInvocation {
    if (req.mcpServers?.length) {
      // Failing loudly beats silently dropping the database tools the caller asked for.
      throw new Error('Injecting MCP servers is not supported for Antigravity yet');
    }
    const prompt = req.systemPrompt ? `${req.systemPrompt}\n\n${req.prompt}` : req.prompt;
    if (prompt.length > MAX_PROMPT_CHARS) {
      throw new Error(`Prompt is ${prompt.length} characters; the Antigravity CLI takes it as an argument and the limit is ${MAX_PROMPT_CHARS}`);
    }
    const args = [`-p=${prompt}`, '--output-format', 'stream-json', ...ACCESS_ARGS[req.access ?? 'read-only']];
    if (req.model) args.push('--model', req.model);
    if (req.sessionId) args.push('--conversation', req.sessionId);
    return { args, stdin: '' };
  }

  protected createParser(): Parser {
    let sessionSeen = false;
    let assistantText = '';
    const startedTools = new Set<number>();
    const reportedAgents = new Set<string>();
    return (raw) => {
      if (!isRecord(raw)) return [];
      const events: AgentEvent[] = [];
      switch (str(raw.event)) {
        case 'init': {
          const id = str(raw.conversation_id);
          if (id && !sessionSeen) {
            sessionSeen = true;
            events.push({ type: 'session', sessionId: id });
          }
          break;
        }
        case 'step_update': {
          const step = isRecord(raw.step_update) ? raw.step_update : {};
          const kind = str(step.step_type);
          const state = str(step.state);
          const index = num(step.step_index);
          const delegation = isRecord(step.subagent_info) ? step.subagent_info.subagents : undefined;
          if (Array.isArray(delegation)) {
            for (const [position, agent] of delegation.entries()) {
              if (!isRecord(agent)) continue;
              const agentId = str(agent.conversation_id) ?? (index === undefined ? undefined : [index, position].join(':'));
              if (!agentId || reportedAgents.has(agentId)) continue;
              reportedAgents.add(agentId);
              events.push({ type: 'subagent', agentId, label: (str(agent.type_name) ?? 'Subagente do Gemini').slice(0, 180),
                detail: str(agent.role)?.slice(0, 240), status: 'running' });
            }
          }
          if (kind === 'agent_response') {
            const delta = str(step.text_delta);
            if (delta) {
              assistantText += delta;
              events.push({ type: 'text', text: delta, partial: true });
            }
          } else if (kind && kind !== 'user_input') {
            // Observed live: { step_type: "tool", tool_name: "write_file", tool_info: { name, parameters } }.
            const info = isRecord(step.tool_info) ? step.tool_info : {};
            const name = str(step.tool_name) ?? str(info.name) ?? kind;
            if (index !== undefined && !startedTools.has(index)) {
              startedTools.add(index);
              // Text before a tool is often a progress update rather than the answer to the turn.
              if (kind === 'tool') assistantText = '';
              events.push({ type: 'tool_call', name, input: info.parameters });
            }
            const isError = (step.error ?? info.error) != null;
            if (!isError && name === 'run_command') for (const url of commandPreviews(str(info.output) ?? '')) events.push({ type: 'preview', url });
            if (state === 'DONE') events.push({ type: 'tool_result', name, isError });
          }
          break;
        }
        case 'result': {
          const result = isRecord(raw.result) ? raw.result : {};
          const usage = isRecord(result.usage) ? result.usage : {};
          events.push({ type: 'usage', inputTokens: num(usage.input_tokens), outputTokens: num(usage.output_tokens) });
          const status = str(result.status);
          const text = str(result.response)?.trim() || assistantText.trim() || undefined;
          if (status !== 'SUCCESS') {
            events.push({ type: 'error', message: str(result.error)?.trim() || `Antigravity finished with status ${status ?? 'unknown'}` });
            events.push({ type: 'done', status: 'error', text });
          } else if (!text) {
            events.push({ type: 'error', code: 'missing-response', message: 'O Antigravity encerrou sem enviar uma resposta final. Confira as etapas da execução antes de continuar.' });
            events.push({ type: 'done', status: 'error' });
          } else {
            events.push({ type: 'done', status: 'ok', text });
          }
          break;
        }
      }
      return events;
    };
  }
}
