import path from 'node:path';
import type { Adapter, AgentEvent, McpServerSpec, ProviderId, UserQuestion } from '@aio/core';
import { peerServerSpec, type PeerServerLaunch } from './peer-launch.js';
import { buildPrompt } from './prompt.js';
import { FileTranscript, MemoryTranscript } from './transcript.js';
import { looksRateLimited, UsageTracker } from './usage.js';
import type { RoomAttachment, RoomEvent, RoomMessage, TranscriptStore, TurnOptions, TurnResult } from './types.js';
import { splitQuestion } from './question.js';

const DEFAULT_TIMEOUT_MS = 600_000;

export interface RoomConfig {
  adapters: Partial<Record<ProviderId, Adapter>>;
  /** Working directory the models see. */
  cwd: string;
  transcript?: TranscriptStore;
  usage?: UsageTracker;
  onEvent?: (event: RoomEvent) => void;
  onTranscript?: (provider?: ProviderId) => void;
  onQuestion?: (provider: ProviderId, question: UserQuestion) => Promise<string | undefined>;
  /**
   * How to start the `room` MCP server for models that can use it. Needs a `FileTranscript`, because the server
   * is a separate process and shares the room through that file.
   */
  peerServer?: PeerServerLaunch;
}

export interface PlannedTurn {
  provider: ProviderId | ProviderId[];
  instruction: string;
  options?: TurnOptions;
}

const failed = (provider: ProviderId, error: string, rateLimited = false): TurnResult => ({
  provider,
  status: 'error',
  text: '',
  usage: { inputTokens: 0, outputTokens: 0, costUsd: 0 },
  error,
  rateLimited,
});

export class Room {
  readonly transcript: TranscriptStore;
  readonly usage: UsageTracker;

  constructor(private readonly config: RoomConfig) {
    this.transcript = config.transcript ?? new MemoryTranscript();
    this.usage = config.usage ?? new UsageTracker();
    if (config.peerServer && !(this.transcript instanceof FileTranscript)) {
      throw new Error('peerServer needs a FileTranscript: the peer server is another process and shares the room through a file');
    }
  }

  get providers(): ProviderId[] {
    return Object.keys(this.config.adapters) as ProviderId[];
  }

  /** A message from the user (the task, a correction). */
  async say(text: string, attachments?: RoomAttachment[]): Promise<void> {
    await this.transcript.append({ author: 'user', text, ...(attachments?.length ? { attachments } : {}) });
    this.config.onTranscript?.();
  }

  messages(): Promise<RoomMessage[]> {
    return this.transcript.list();
  }

  /**
   * One participant takes a turn. With several candidates they are tried in order: a provider that is out of quota,
   * not signed in or failing hands the turn to the next one, and the message is signed by whoever actually answered.
   */
  async turn(who: ProviderId | ProviderId[], instruction: string, options: TurnOptions = {}): Promise<TurnResult> {
    const snapshot = await this.transcript.list();
    const result = await this.attempt(who, instruction, options, snapshot);
    await this.record(result, options);
    return result;
  }

  /**
   * Several participants answer at the same time from the same snapshot, so none of them is swayed by another's
   * answer. Their messages are appended afterwards in the order given, whatever order they finished in.
   */
  async round(turns: PlannedTurn[]): Promise<TurnResult[]> {
    const snapshot = await this.transcript.list();
    const results = await Promise.all(turns.map((t) => this.attempt(t.provider, t.instruction, t.options ?? {}, snapshot)));
    for (const [i, result] of results.entries()) await this.record(result, turns[i]!.options ?? {});
    return results;
  }

  private async record(result: TurnResult, options: TurnOptions): Promise<void> {
    if (options.record === false || result.status === 'cancelled') return;
    if (result.status === 'ok') {
      await this.transcript.append({ author: result.provider, text: result.text });
    } else {
      // A failed turn is visible to the others, but never passed off as the model's own words.
      await this.transcript.append({ author: 'system', text: `${result.provider} could not answer: ${result.error ?? 'unknown error'}` });
    }
    this.config.onTranscript?.(result.provider);
  }

  private async attempt(who: ProviderId | ProviderId[], instruction: string, options: TurnOptions, snapshot: RoomMessage[]): Promise<TurnResult> {
    const candidates = Array.isArray(who) ? who : [who];
    const notes: string[] = [];
    let last: TurnResult | undefined;
    for (const provider of candidates) {
      if (options.signal?.aborted) return { ...(last ?? failed(provider, 'Cancelled')), status: 'cancelled', text: '', error: undefined };
      if (!this.config.adapters[provider]) {
        this.config.onEvent?.({ type: 'skipped', provider, reason: 'not configured' });
        notes.push(`${provider}: not configured`);
        if (options.fallbackOnLimitOnly) break;
        continue;
      }
      if (this.usage.isLimited(provider)) {
        this.config.onEvent?.({ type: 'skipped', provider, reason: 'recently hit its usage limit' });
        notes.push(`${provider}: recently hit its usage limit`);
        continue;
      }
      // The model and the session belong to the first provider; another one starts from its own defaults.
      const own = provider === candidates[0] ? options : { ...options, model: undefined, effort: undefined, sessionId: undefined };
      last = await this.execute(provider, instruction, own, snapshot);
      if (last.status !== 'error' || (options.fallbackOnLimitOnly && !last.rateLimited)) return last;
      notes.push(`${provider}: ${last.error ?? 'failed'}`);
    }
    if (last) return candidates.length > 1 ? { ...last, error: notes.join('; ') } : last;
    return failed(candidates[0] ?? 'claude', `No provider available (${notes.join('; ') || 'none requested'})`);
  }

  private peerTools(provider: ProviderId, options: TurnOptions): McpServerSpec[] | undefined {
    const launch = this.config.peerServer;
    const adapter = this.config.adapters[provider];
    if (!options.withPeerTools || !launch || !adapter?.supportsMcp) return undefined;
    const wanted = launch.team ? (Object.keys(launch.team) as ProviderId[]) : this.providers;
    const peers = this.providers.filter((p) => p !== provider && wanted.includes(p));
    if (peers.length === 0) return undefined;
    return [peerServerSpec({ ...launch, self: provider, peers, transcriptFile: (this.transcript as FileTranscript).file, cwd: options.cwd ?? this.config.cwd })];
  }

  private async execute(provider: ProviderId, instruction: string, options: TurnOptions, snapshot: RoomMessage[]): Promise<TurnResult> {
    const ask = this.config.onQuestion;
    let turn = await this.executeTurn(provider, instruction, options, snapshot);
    let questions = 0;
    while (ask && turn.question && turn.result.status === 'ok') {
      const { question, result } = turn;
      if (++questions > 5) return { ...result, status: 'error', text: '', error: 'O modelo pediu esclarecimentos demais nesta etapa.' };
      await this.transcript.append({ author: provider, text: result.text });
      this.config.onTranscript?.(provider);
      const beforeAnswer = (await this.transcript.list()).length;
      const answer = options.signal?.aborted ? undefined : await ask(provider, question);
      if (answer === undefined || options.signal?.aborted) return { ...result, status: 'cancelled', text: '' };
      await this.say(answer);
      const sessionId = this.config.adapters[provider]?.supportsResume ? result.sessionId : undefined;
      const next = { ...options, sessionId, sinceIndex: beforeAnswer };
      turn = await this.executeTurn(provider, `${instruction}\nContinue the same task using the user's answer to your clarification.`, next, await this.transcript.list());
    }
    return turn.result;
  }

  private async executeTurn(provider: ProviderId, instruction: string, options: TurnOptions, snapshot: RoomMessage[]): Promise<{ result: TurnResult; question?: UserQuestion }> {
    const adapter = this.config.adapters[provider]!;
    const peer = this.peerTools(provider, options);
    const extra = adapter.supportsMcp ? (options.mcpServers ?? []) : [];
    const mcpServers = peer || extra.length ? [...extra, ...(peer ?? [])] : undefined;
    const resumed = options.sessionId !== undefined;
    const transcript = resumed ? snapshot.filter((m) => m.index > (options.sinceIndex ?? 0)) : snapshot;
    const latestUser = transcript.slice().reverse().find((m) => m.author === 'user');
    const attachmentImages = latestUser?.attachments?.filter((file) => /\.(?:png|jpe?g|gif|webp)$/i.test(file.path)).map((file) => file.path);
    const attachmentDirectories = [...new Set(snapshot.flatMap((message) => message.attachments?.map((file) => path.dirname(file.path)) ?? []))];
    const { systemPrompt, prompt } = buildPrompt({
      self: provider,
      participants: this.providers,
      team: peer ? this.providers.filter((p) => p !== provider && (this.config.peerServer?.team ? p in this.config.peerServer.team : true)) : undefined,
      // A resumed session already remembers everything up to its last turn: only what is new needs to be said.
      transcript,
      resumed,
      instruction,
      role: provider === 'gemini' && (options.access ?? 'read-only') === 'read-only'
        ? [options.role, 'This turn has read-only access. Use file-reading and search tools to inspect the project. Avoid shell commands and file changes because this session cannot ask for tool approval. If an action is blocked, answer using the evidence already available and explain what could not be verified.'].filter(Boolean).join('\n')
        : options.role,
      interactive: !!this.config.onQuestion,
    });
    const emit = this.config.onEvent;
    emit?.({ type: 'turn_start', provider, instruction });

    let sessionId: string | undefined;
    let doneText: string | undefined;
    let status: TurnResult['status'] = 'ok';
    let error: string | undefined;
    let errorCode: TurnResult['errorCode'];
    let nativeQuestion: UserQuestion | undefined;
    const usage = { inputTokens: 0, outputTokens: 0, costUsd: 0 };
    const whole: string[] = [];
    const partial: string[] = [];

    try {
      const events: AsyncGenerator<AgentEvent, void> = adapter.run({
        prompt,
        systemPrompt,
        cwd: options.cwd ?? this.config.cwd,
        access: options.access ?? 'read-only',
        model: options.model || undefined,
        effort: options.effort || undefined,
        sessionId: options.sessionId || undefined,
        mcpServers,
        ...(attachmentImages?.length ? { attachmentImages } : {}),
        ...(attachmentDirectories.length ? { attachmentDirectories } : {}),
        signal: options.signal,
        timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      });
      turnEvents: for await (const ev of events) {
        switch (ev.type) {
          case 'session':
            sessionId = ev.sessionId;
            break;
          case 'text':
            (ev.partial ? partial : whole).push(ev.text);
            emit?.({ type: 'text', provider, text: ev.text, partial: ev.partial === true });
            break;
          case 'tool_call':
            emit?.({ type: 'tool_call', provider, name: ev.name });
            break;
          case 'tool_result':
            emit?.({ type: 'tool_result', provider, name: ev.name, isError: ev.isError === true });
            break;
          case 'subagent':
          case 'preview':
            emit?.({ ...ev, provider });
            break;
          case 'question':
            if (this.config.onQuestion) {
              // The headless CLI cannot accept the native tool's reply. Close this turn and continue with the transcript.
              nativeQuestion = { question: ev.question, options: ev.options };
              sessionId = undefined;
              break turnEvents;
            }
            break;
          case 'usage':
            usage.inputTokens += ev.inputTokens ?? 0;
            usage.outputTokens += ev.outputTokens ?? 0;
            usage.costUsd += ev.costUsd ?? 0;
            break;
          case 'limit':
            this.usage.noteWindow(provider, { status: ev.status, name: ev.window, resetsAt: ev.resetsAt, usedPercent: ev.usedPercent });
            emit?.({ type: 'limit', provider, status: ev.status, window: ev.window, resetsAt: ev.resetsAt, usedPercent: ev.usedPercent });
            break;
          case 'error':
            error = error ? `${error}; ${ev.message}` : ev.message;
            errorCode ??= ev.code;
            break;
          case 'done':
            status = ev.status;
            doneText = ev.text;
            break;
        }
      }
    } catch (err) {
      // Adapters promise not to throw; if one does, the room must still get a result.
      status = 'error';
      error = err instanceof Error ? err.message : String(err);
    }
    if (options.signal?.aborted) status = 'cancelled';

    // The CLI's own final answer wins; otherwise what streamed (a whole message beats concatenated deltas).
    const rawText = (doneText ?? whole.at(-1) ?? partial.join('')).trimEnd();
    const parsed = this.config.onQuestion && status === 'ok' ? splitQuestion(rawText) : undefined;
    const question = nativeQuestion ?? parsed?.question;
    const text = question ? [parsed?.body ?? rawText, question.question].filter(Boolean).join('\n\n') : rawText;
    if (status === 'ok' && !text.trim()) {
      status = 'error';
      error = `${adapter.displayName} returned an empty answer`;
    }
    if (status === 'error' && !error) error = `${adapter.displayName} failed`;

    const result: TurnResult = {
      provider,
      status,
      text: status === 'ok' ? text : '',
      sessionId,
      usage,
      error: status === 'error' ? error : undefined,
      ...(status === 'error' && errorCode ? { errorCode } : {}),
      rateLimited: status === 'error' && looksRateLimited(error),
    };
    this.usage.record(result);
    emit?.({ type: 'turn_end', result });
    return { result, question };
  }
}
