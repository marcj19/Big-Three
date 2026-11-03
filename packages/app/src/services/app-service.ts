import { stat } from 'node:fs/promises';
import path from 'node:path';
import { createAdapters, DEFAULT_MODEL, type Adapter, type ProviderId } from '@aio/core';
import { brokerServerSpec, KeyringSecretStore, type BrokerLaunchInput, type WritableSecretStore } from '@aio/db-broker';
import { UsageTracker, validateFlow } from '@aio/room';
import { z } from 'zod';
import type {
  Access,
  Api,
  AppEvent,
  ConnectionInput,
  ConnectionTest,
  ConnectionView,
  ConversationMeta,
  MessageView,
  ModelOption,
  ProviderStatus,
  StartRun,
  UsageView,
} from '../shared/api.js';
import { ConnectionService } from './connections.js';
import { ConversationStore } from './conversations.js';
import { RunManager } from './runs.js';

export interface AccessRequest {
  access: Exclude<Access, 'read-only'>;
  cwd: string;
  summary: string;
}

export interface AppServiceOptions {
  /** Folder for connections.json, the audit log and the conversations. */
  configDir: string;
  adapters?: Partial<Record<ProviderId, Adapter>>;
  vault?: WritableSecretStore;
  emit?: (event: AppEvent) => void;
  /** Asks the person (outside the web page) before a model may change files. Without it, writing is refused. */
  confirmAccess?: (request: AccessRequest) => Promise<boolean>;
  pickFolder?: () => Promise<string | null>;
  /** Overrides where the database broker and room server start from (tests). */
  brokerEntry?: string;
  peerEntry?: string;
  timeoutMs?: number;
}

const providerId = z.enum(['claude', 'gemini', 'codex']);
const access = z.enum(['read-only', 'edit', 'full']);
// Model and effort become command-line arguments, so only plain names are accepted (the adapters check again).
const modelName = z.string().max(100).regex(/^[A-Za-z0-9][A-Za-z0-9._:/-]*$/).or(z.literal(''));
const effortName = z.string().regex(/^[a-z]{3,10}$/).or(z.literal(''));
const stepSchema = z.object({
  kind: z.enum(['answer', 'plan', 'execute', 'review', 'revise', 'debate']),
  provider: providerId,
  model: modelName.optional(),
  effort: effortName.optional(),
  access: access.optional(),
  members: z.array(z.object({ provider: providerId, model: modelName.optional(), effort: effortName.optional() })).max(3).optional(),
  rounds: z.number().int().min(1).max(4).optional(),
});
const choiceSchema = z.object({ provider: providerId, model: modelName.optional(), effort: effortName.optional() });
const runSchema = z.object({
  conversationId: z.string(),
  prompt: z.string().trim().min(1, 'Write something first').max(20_000),
  spec: z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('chat'), providers: z.array(providerId).min(1).max(3), access }),
    z.object({ kind: z.literal('review'), author: providerId, reviewer: providerId }),
    z.object({ kind: z.literal('plan'), planner: providerId, executor: providerId, reviewer: providerId.optional(), executorAccess: access }),
    z.object({ kind: z.literal('debate'), participants: z.array(providerId).min(2).max(3), rounds: z.number().int().min(1).max(4).optional(), judge: providerId.optional() }),
    z.object({ kind: z.literal('lead'), lead: choiceSchema, access, team: z.array(choiceSchema).max(2), fallback: z.boolean() }),
    z.object({ kind: z.literal('flow'), steps: z.array(stepSchema).min(1).max(8), fallback: z.boolean() }),
  ]),
  connections: z.array(z.string()).max(20),
  peerTools: z.boolean(),
});

const RANK: Record<Access, number> = { 'read-only': 0, edit: 1, full: 2 };
/** The most any model in this run may do to your files. */
const writeAccess = (spec: StartRun['spec']): Access =>
  spec.kind === 'chat' || spec.kind === 'lead'
    ? spec.access
    : spec.kind === 'plan'
      ? spec.executorAccess
      : spec.kind === 'flow'
        ? spec.steps.reduce<Access>((top, s) => (s.kind === 'execute' && s.access && RANK[s.access] > RANK[top] ? s.access : top), 'read-only')
        : 'read-only';
const providersOf = (spec: StartRun['spec']): ProviderId[] =>
  spec.kind === 'chat'
    ? spec.providers
    : spec.kind === 'review'
      ? [spec.author, spec.reviewer]
      : spec.kind === 'plan'
        ? [spec.planner, spec.executor, ...(spec.reviewer ? [spec.reviewer] : [])]
        : spec.kind === 'flow'
          ? spec.steps.flatMap((s) => [s.provider, ...(s.members ?? []).map((m) => m.provider)])
          : spec.kind === 'lead'
            ? [spec.lead.provider, ...spec.team.map((m) => m.provider)]
            : spec.participants;

/**
 * Everything the window can ask for. The window is a web page, so every input is validated here: it must never be
 * able to reach files, run models with write access, or read a password just by sending different arguments.
 */
export class AppService implements Api {
  readonly adapters: Partial<Record<ProviderId, Adapter>>;
  readonly usageTracker = new UsageTracker();
  private readonly store: ConversationStore;
  private readonly connections: ConnectionService;
  private readonly runs: RunManager;
  private readonly logins = new Map<ProviderId, AbortController>();

  constructor(private readonly options: AppServiceOptions) {
    this.adapters = options.adapters ?? createAdapters();
    const vault = options.vault ?? new KeyringSecretStore();
    this.store = new ConversationStore(path.join(options.configDir, 'conversations'));
    this.connections = new ConnectionService(options.configDir, vault);
    this.runs = new RunManager({
      adapters: this.adapters,
      store: this.store,
      usage: this.usageTracker,
      emit: (e) => this.emit(e),
      databaseTools: (names) => this.databaseTools(names),
      peerEntry: options.peerEntry,
      timeoutMs: options.timeoutMs,
    });
  }

  private emit(event: AppEvent): void {
    this.options.emit?.(event);
  }

  private databaseTools(connections: string[]) {
    const launch: BrokerLaunchInput = { configDir: this.options.configDir, connections, entry: this.options.brokerEntry };
    return brokerServerSpec(launch);
  }

  async listModels(id: ProviderId): Promise<ModelOption[]> {
    const adapter = this.adapters[providerId.parse(id)];
    if (!adapter) return [];
    try {
      return await adapter.listModels();
    } catch {
      return [DEFAULT_MODEL]; // a failing list must not stop anyone from using the default
    }
  }

  async providersStatus(): Promise<ProviderStatus[]> {
    return Promise.all(
      (Object.values(this.adapters) as Adapter[]).map(async (a) => {
        const found = await a.detect();
        const auth = found.available ? await a.authStatus() : { signedIn: false as const };
        return {
          id: a.id,
          displayName: a.displayName,
          available: found.available,
          version: found.version,
          reason: found.reason,
          signedIn: auth.signedIn,
          canLogin: a.canLogin,
          supportsMcp: a.supportsMcp,
          efforts: [...a.efforts],
        };
      }),
    );
  }

  async loginProvider(id: ProviderId): Promise<void> {
    const adapter = this.adapters[providerId.parse(id)];
    if (!adapter) throw new Error('That model is not configured');
    this.logins.get(id)?.abort();
    const ac = new AbortController();
    this.logins.set(id, ac);
    // Runs in the background: the browser sign-in can take minutes, and its progress arrives as events.
    void (async () => {
      try {
        for await (const event of adapter.login(ac.signal)) this.emit({ type: 'login', provider: id, event });
      } finally {
        if (this.logins.get(id) === ac) this.logins.delete(id);
      }
    })();
  }

  async cancelLogin(id: ProviderId): Promise<void> {
    this.logins.get(providerId.parse(id))?.abort();
  }

  listConnections(): Promise<ConnectionView[]> {
    return this.connections.list();
  }
  saveConnection(input: ConnectionInput): Promise<void> {
    return this.connections.save(input);
  }
  deleteConnection(name: string): Promise<void> {
    return this.connections.remove(name);
  }
  setPassword(name: string, password: string): Promise<void> {
    return this.connections.setPassword(name, password);
  }
  clearPassword(name: string): Promise<void> {
    return this.connections.clearPassword(name);
  }
  testConnection(name: string): Promise<ConnectionTest> {
    return this.connections.test(name);
  }

  listConversations(): Promise<ConversationMeta[]> {
    return this.store.list();
  }

  async createConversation(input: { cwd: string; title?: string }): Promise<ConversationMeta> {
    const cwd = path.resolve(input.cwd);
    if (!(await stat(cwd).then((s) => s.isDirectory(), () => false))) throw new Error('That folder does not exist');
    return this.store.create({ cwd, title: input.title });
  }

  async getConversation(id: string): Promise<{ meta: ConversationMeta; messages: MessageView[] }> {
    return { meta: await this.store.get(id), messages: await this.store.messages(id) };
  }
  renameConversation(id: string, title: string): Promise<void> {
    return this.store.rename(id, title);
  }
  async deleteConversation(id: string): Promise<void> {
    if (this.runs.isBusy(id)) throw new Error('Cancel the running task first');
    await this.store.remove(id);
  }

  async startRun(raw: StartRun): Promise<{ runId: string }> {
    const input = runSchema.parse(raw) as StartRun;
    const meta = await this.store.get(input.conversationId);
    if (!(await stat(meta.cwd).then((s) => s.isDirectory(), () => false))) throw new Error('The conversation folder no longer exists');

    const missing = providersOf(input.spec).filter((p) => !this.adapters[p]);
    if (missing.length) throw new Error(`Not available: ${missing.join(', ')}`);
    const known = new Set((await this.connections.profiles()).map((p) => p.name));
    const unknown = input.connections.filter((c) => !known.has(c));
    if (unknown.length) throw new Error(`Unknown connection: ${unknown.join(', ')}`);

    if (input.spec.kind === 'flow') {
      const problem = validateFlow(input.spec.steps);
      if (problem) throw new Error(problem);
    }
    const level = writeAccess(input.spec);
    if (level !== 'read-only') {
      // Asked here, in the main process, because the window is a web page and could claim the person said yes.
      const ok = await this.options.confirmAccess?.({
        access: level,
        cwd: meta.cwd,
        summary:
          input.spec.kind === 'plan'
            ? `${input.spec.executor} will carry out the plan`
            : input.spec.kind === 'flow'
              ? `${input.spec.steps.filter((s) => s.kind === 'execute').map((s) => s.provider).join(', ')} will carry out step(s) that change files`
              : `${providersOf(input.spec).join(', ')} may act`,
      });
      if (!ok) throw new Error('Write access was not confirmed, so nothing was started');
    }
    return { runId: this.runs.start(input, meta.cwd) };
  }

  async cancelRun(runId: string): Promise<void> {
    this.runs.cancel(runId);
  }

  async usage(): Promise<Record<string, UsageView>> {
    return Object.fromEntries(
      Object.entries(this.usageTracker.snapshot()).map(([k, v]) => [
        k,
        { turns: v.turns, failures: v.failures, inputTokens: v.inputTokens, outputTokens: v.outputTokens, limitedUntil: v.limitedUntil, window: v.window },
      ]),
    );
  }

  async pickFolder(): Promise<string | null> {
    return (await this.options.pickFolder?.()) ?? null;
  }
}
