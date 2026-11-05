import { randomUUID } from 'node:crypto';
import type { Adapter, McpServerSpec, ProviderId } from '@aio/core';
import { crossReview, debate, planExecute, Room, runFlow, type FlowStep, type PatternResult, type RoomEvent, type Team, type UsageTracker } from '@aio/room';
import type { AppEvent, RoomEventView, RunOutcome, StartRun } from '../shared/api.js';
import type { ConversationStore } from './conversations.js';
import { watchPeerActivity } from './peer-activity.js';
import type { RunJournal } from './run-journal.js';

export interface RunDeps {
  adapters: Partial<Record<ProviderId, Adapter>>;
  store: ConversationStore;
  usage: UsageTracker;
  emit: (event: AppEvent) => void;
  /** MCP server giving models read-only database access to these connections. */
  databaseTools: (connections: string[]) => McpServerSpec | undefined;
  /** Where the room's ask_peer server starts from; defaults to the one shipped with @aio/room. */
  peerEntry?: string;
  timeoutMs?: number;
  journal?: RunJournal;
}

/** The teammates the lead may consult and the model each one answers with. */
const teamOf = (members: { provider: ProviderId; model?: string; effort?: string }[], lead: ProviderId): Team =>
  Object.fromEntries(members.filter((m) => m.provider !== lead).map((m) => [m.provider, { model: m.model || undefined, effort: m.effort || undefined }]));

const toView = (e: RoomEvent): RoomEventView =>
  e.type === 'turn_end'
    ? { type: 'turn_end', provider: e.result.provider, status: e.result.status, error: e.result.error, inputTokens: e.result.usage.inputTokens, outputTokens: e.result.usage.outputTokens }
    : e;

const fromPattern = (r: PatternResult): RunOutcome => ({ status: r.status, final: r.final, verdict: r.verdict, error: r.error });

/** One run at a time per conversation: two runs appending to the same transcript would interleave their turns. */
export class RunManager {
  private readonly active = new Map<string, { conversationId: string; abort: AbortController }>();

  constructor(private readonly deps: RunDeps) {}

  isBusy(conversationId: string): boolean {
    return [...this.active.values()].some((r) => r.conversationId === conversationId);
  }

  /** Starts in the background and returns at once; progress and the result arrive as events. */
  start(input: StartRun, cwd: string): string {
    if (this.isBusy(input.conversationId)) throw new Error('This conversation is already running. Wait for it or cancel it.');
    const runId = randomUUID();
    this.deps.journal?.begin(runId, input);
    const abort = new AbortController();
    this.active.set(runId, { conversationId: input.conversationId, abort });
    void this.execute(runId, input, cwd, abort).finally(() => this.active.delete(runId));
    return runId;
  }

  cancel(runId: string): void {
    this.active.get(runId)?.abort.abort();
  }

  private publish(event: AppEvent): void {
    if ('runId' in event) this.deps.journal?.event(event.runId, event);
    this.deps.emit(event);
  }

  /**
   * One model answers and, when it needs to, consults the team itself. Its own CLI session is continued from turn to
   * turn, so it remembers what it read and did; only what happened in the room since is sent again.
   */
  private async runLead(room: Room, input: StartRun, spec: Extract<StartRun['spec'], { kind: 'lead' }>, common: { cwd: string; signal: AbortSignal; mcpServers?: McpServerSpec[] }): Promise<RunOutcome> {
    const { deps } = this;
    const lead = spec.lead.provider;
    const meta = await deps.store.get(input.conversationId);
    await room.say(input.prompt);

    // Another model may stand in on a limit, but never while files may be changed.
    const order: ProviderId[] = ['claude', 'gemini', 'codex'];
    const candidates = [lead, ...(spec.fallback && spec.access === 'read-only' ? order.filter((p) => p !== lead && deps.adapters[p]) : [])];
    const turn = (session?: { id: string; upto: number }) =>
      room.turn(candidates, "Answer the user's latest message.", {
        ...common,
        timeoutMs: deps.timeoutMs,
        access: spec.access,
        model: spec.lead.model,
        effort: spec.lead.effort,
        withPeerTools: input.peerTools,
        sessionId: session?.id,
        sinceIndex: session?.upto,
      });

    let result = await turn(meta.sessions?.[lead]);
    // A session that no longer exists (or was cut short) must not trap the conversation: start over with the transcript.
    if (result.status === 'error' && meta.sessions?.[lead] && !result.rateLimited) {
      await deps.store.setSession(input.conversationId, lead, undefined);
      result = await turn(undefined);
    }
    if (result.status === 'ok' && result.provider === lead && result.sessionId) {
      await deps.store.setSession(input.conversationId, lead, { id: result.sessionId, upto: (await room.messages()).length });
    }
    return { status: result.status, final: result.text, error: result.error };
  }

  private async execute(runId: string, input: StartRun, cwd: string, abort: AbortController): Promise<void> {
    const { deps } = this;
    const conversationId = input.conversationId;
    let outcome: RunOutcome;
    let activity: Awaited<ReturnType<typeof watchPeerActivity>> | undefined;
    try {
      if (input.peerTools) {
        activity = await watchPeerActivity((event) => {
          const allowed = input.spec.kind !== 'lead' || input.spec.team.some((member) => member.provider === event.peer);
          if (allowed) this.publish({ type: 'peer_activity', runId, conversationId, ...event });
        }).catch(() => undefined);
      }
      const room = new Room({
        adapters: deps.adapters,
        cwd,
        transcript: deps.store.transcript(conversationId),
        usage: deps.usage,
        onEvent: (event) => this.publish({ type: 'room', runId, conversationId, event: toView(event) }),
        peerServer: input.peerTools ? { entry: deps.peerEntry, activityFile: activity?.file, team: input.spec.kind === 'lead' ? teamOf(input.spec.team, input.spec.lead.provider) : undefined } : undefined,
      });
      const db = input.connections.length ? deps.databaseTools(input.connections) : undefined;
      const common = { cwd, signal: abort.signal, timeoutMs: deps.timeoutMs, withPeerTools: input.peerTools, mcpServers: db ? [db] : undefined };
      const { spec } = input;

      if (spec.kind === 'chat') {
        await room.say(input.prompt);
        const r = await room.turn(spec.providers, "Answer the user's latest message.", { ...common, access: spec.access });
        outcome = { status: r.status, final: r.text, error: r.error };
      } else if (spec.kind === 'review') {
        outcome = fromPattern(await crossReview(room, { task: input.prompt, author: spec.author, reviewer: spec.reviewer, ...common }));
      } else if (spec.kind === 'plan') {
        outcome = fromPattern(
          await planExecute(room, { task: input.prompt, planner: spec.planner, executor: spec.executor, executorAccess: spec.executorAccess, reviewer: spec.reviewer, ...common }),
        );
      } else if (spec.kind === 'lead') {
        outcome = await this.runLead(room, input, spec, { cwd, signal: abort.signal, mcpServers: db ? [db] : undefined });
      } else if (spec.kind === 'flow') {
        const order: ProviderId[] = ['claude', 'gemini', 'codex'];
        const steps: FlowStep[] = spec.steps.map((s) => ({
          ...s,
          // Another model may stand in when one hits its limit, but never for a step that changes files.
          fallback: spec.fallback && s.kind !== 'execute' ? order.filter((p) => p !== s.provider && deps.adapters[p]) : undefined,
        }));
        outcome = fromPattern(
          await runFlow(room, {
            task: input.prompt,
            steps,
            ...common,
            onStep: (step) => this.publish({ type: 'step', runId, conversationId, step }),
          }),
        );
      } else {
        outcome = fromPattern(await debate(room, { question: input.prompt, participants: spec.participants, rounds: spec.rounds, judge: spec.judge, ...common }));
      }
      await deps.store.touch(conversationId, input.prompt);
    } catch (err) {
      outcome = { status: 'error', final: '', error: err instanceof Error ? err.message : String(err) };
    }
    await activity?.close();
    const finished: AppEvent = { type: 'run_done', runId, conversationId, outcome };
    deps.journal?.event(runId, finished);
    await deps.journal?.save(runId).catch(() => {});
    deps.emit(finished);
  }
}
