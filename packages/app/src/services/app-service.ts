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
  PermissionKey,
  PermissionsView,
  ProviderStatus,
  StartRun,
  UsageView,
  AccountQuota,
  UpdateCommand,
  UpdateState,
} from '../shared/api.js';
import { ConnectionService } from './connections.js';
import { ConversationStore } from './conversations.js';
import { RunBusyError, RunManager } from './runs.js';
import { RunJournal } from './run-journal.js';
import { workspaceDirectory, workspaceFile } from './workspace.js';
import { gitDiff, gitStatus } from './git.js';
import { browserUrl } from '../shared/browser-url.js';
import type { BrowserBounds, BrowserState } from '../shared/api.js';
import { ATTACHMENT_COUNT_LIMIT, ATTACHMENT_FILE_LIMIT, ATTACHMENT_ONLY_PROMPT } from '../shared/api.js';
import { mobilePromptRun, type MobilePrompt } from '../shared/mobile.js';
import { mobileOffice } from '../shared/mobile-office.js';
import { timelineEntries } from '../shared/work-trace.js';

export interface AccessRequest {
  access: Exclude<Access, 'read-only'>;
  cwd: string;
  summary: string;
}

export interface PermissionRequest {
  permission: PermissionKey;
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
  /** Asks the person, outside the web page, before a model may use the web or drive the browser. Without it, neither can be turned on. */
  confirmPermission?: (request: PermissionRequest) => Promise<boolean>;
  /** The native host can reuse grants that were saved after its confirmation. */
  rememberConversationAccess?: boolean;
  pickFolder?: () => Promise<string | null>;
  /** Overrides where the database broker and room server start from (tests). */
  brokerEntry?: string;
  peerEntry?: string;
  timeoutMs?: number;
  browser?: { state(): BrowserState; navigate(url: string): Promise<void>; command(command: 'back' | 'forward' | 'reload' | 'stop'): void; bounds(bounds: BrowserBounds): void };
  updates?: { state(): UpdateState; perform(command: UpdateCommand): Promise<UpdateState> };
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
  prompt: z.string().trim().max(20_000),
  attachments: z.array(z.object({
    name: z.string().trim().min(1).max(160).regex(/^[^\x00-\x1f\x7f/\\]+$/),
    data: z.string().max(Math.ceil(ATTACHMENT_FILE_LIMIT / 3) * 4),
  })).max(ATTACHMENT_COUNT_LIMIT).optional(),
  spec: z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('chat'), providers: z.array(providerId).min(1).max(3), access }),
    z.object({ kind: z.literal('review'), author: providerId, reviewer: providerId }),
    z.object({ kind: z.literal('plan'), planner: providerId, executor: providerId, reviewer: providerId.optional(), executorAccess: access }),
    z.object({ kind: z.literal('debate'), participants: z.array(providerId).min(2).max(3), rounds: z.number().int().min(1).max(4).optional(), judge: providerId.optional() }),
    z.object({ kind: z.literal('lead'), lead: choiceSchema, access, team: z.array(choiceSchema).max(2), fallback: z.boolean(), consultTeam: z.boolean().optional() }),
    z.object({ kind: z.literal('flow'), steps: z.array(stepSchema).min(1).max(8), fallback: z.boolean() }),
  ]),
  connections: z.array(z.string()).max(20),
  peerTools: z.boolean(),
});

const RANK: Record<Access, number> = { 'read-only': 0, edit: 1, full: 2 };
class MobilePermissionError extends Error {}
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
  private readonly journal: RunJournal;
  private readonly logins = new Map<ProviderId, AbortController>();
  private readonly conversationAccess = new Map<string, { cwd: string; level: Access }>();
  private readonly accessRequests = new Set<string>();
  /** Kept in memory only: a restart puts every permission back to off, so nothing stays open without being asked again. */
  private readonly permissionGrants = new Map<string, { cwd: string; granted: PermissionsView }>();
  private readonly permissionRequests = new Set<string>();
  private quotaRead?: Promise<AccountQuota[]>;
  private quotaCache?: { at: number; value: AccountQuota[] };

  constructor(private readonly options: AppServiceOptions) {
    this.adapters = options.adapters ?? createAdapters();
    const vault = options.vault ?? new KeyringSecretStore();
    this.store = new ConversationStore(path.join(options.configDir, 'conversations'));
    this.connections = new ConnectionService(options.configDir, vault);
    this.journal = new RunJournal(path.join(options.configDir, 'runs'));
    this.runs = new RunManager({
      adapters: this.adapters,
      store: this.store,
      usage: this.usageTracker,
      emit: (e) => this.emit(e),
      databaseTools: (names) => this.databaseTools(names),
      peerEntry: options.peerEntry,
      timeoutMs: options.timeoutMs,
      journal: this.journal,
    });
  }

  private emit(event: AppEvent): void {
    this.options.emit?.(event);
  }

  async update(raw?: UpdateCommand): Promise<UpdateState> {
    const command = z.enum(['check', 'download', 'install']).optional().parse(raw);
    const updates = this.options.updates;
    if (!updates) return { phase: 'unavailable' };
    if (command === 'install' && (this.runs.isBusy() || this.accessRequests.size)) {
      throw new Error('Aguarde a tarefa terminar antes de instalar a atualização.');
    }
    return command ? updates.perform(command) : updates.state();
  }

  async workspaceDirectory(conversationId: string, relativePath = '') {
    const meta = await this.store.get(z.string().parse(conversationId));
    return workspaceDirectory(meta.cwd, z.string().max(4096).parse(relativePath));
  }
  async workspaceFile(conversationId: string, relativePath: string) {
    const meta = await this.store.get(z.string().parse(conversationId));
    return workspaceFile(meta.cwd, z.string().min(1).max(4096).parse(relativePath));
  }
  async gitStatus(conversationId: string) {
    const { cwd } = await this.store.get(z.string().parse(conversationId));
    return gitStatus(cwd);
  }
  async gitDiff(conversationId: string, selection: unknown) {
    const { cwd } = await this.store.get(z.string().parse(conversationId));
    return gitDiff(cwd, z.object({
      path: z.string().min(1).max(4096), previousPath: z.string().min(1).max(4096).optional(),
      source: z.enum(['index', 'worktree', 'untracked']),
    }).parse(selection));
  }
  async runHistory(conversationId: string) { await this.store.get(z.string().parse(conversationId)); return this.journal.list(conversationId); }
  async mobileConversations() {
    const conversations = await this.store.list();
    return { conversations: conversations.slice(0, 100).map(({ id, title, updatedAt }) => ({ id, title, updatedAt, running: this.runs.isBusy(id) })),
      office: mobileOffice(this.journal.activeRuns(), new Map(conversations.map(({ id, title }) => [id, title]))) };
  }

  async mobileConversation(id: string) {
    const meta = (await this.store.list()).find((entry) => entry.id === id);
    if (!meta) return undefined;
    const [messages, history] = await Promise.all([this.store.messages(id), this.journal.list(id, 1)]);
    const run = history[0];
    return { title: meta.title, busy: this.runs.isBusy(), messages: messages.slice(-30).map(({ author, at, text }) => ({ author, at, text: text.slice(0, 10_000) })),
      activity: run ? { status: run.status, entries: timelineEntries(run).slice(-18).map(({ at, kind, label, provider, peer, status }) => ({ at, kind, label, provider, peer, status })) } : null };
  }

  async mobileStartPrompt(prompt: MobilePrompt, authorized: () => boolean) {
    try {
      const result = await this.launchRun(mobilePromptRun(prompt), { provider: prompt.provider, authorized });
      return { status: 202, data: result };
    } catch (error) {
      if (error instanceof MobilePermissionError) return { status: 403, message: 'O envio pelo celular foi desativado no PC.' };
      if (error instanceof RunBusyError) return { status: 409, message: 'Aguarde a execução que já está em andamento no PC.' };
      return { status: 422, message: 'Não foi possível iniciar a solicitação. Confira a conversa e o modelo no PC.' };
    }
  }
  async browserState(): Promise<BrowserState> { return this.options.browser?.state() ?? { supported: false, url: '', title: '', loading: false, canBack: false, canForward: false }; }
  async browserNavigate(url: string): Promise<void> {
    const address = browserUrl(z.string().max(4000).parse(url));
    if (!this.options.browser) throw new Error('O navegador integrado está disponível no app desktop.');
    await this.options.browser.navigate(address);
  }
  async browserCommand(command: 'back' | 'forward' | 'reload' | 'stop'): Promise<void> {
    this.options.browser?.command(z.enum(['back', 'forward', 'reload', 'stop']).parse(command));
  }
  async browserBounds(bounds: BrowserBounds): Promise<void> {
    const rect = z.object({ visible: z.boolean(), x: z.number().finite().min(0).max(30000), y: z.number().finite().min(0).max(30000), width: z.number().finite().min(0).max(30000), height: z.number().finite().min(0).max(30000) }).parse(bounds);
    this.options.browser?.bounds(rect);
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

  async getConversation(id: string): Promise<{ meta: ConversationMeta; messages: MessageView[]; access: Access }> {
    const meta = await this.store.get(id);
    return { meta, messages: await this.store.messages(id), access: this.accessFor(meta) };
  }

  private accessFor(meta: ConversationMeta): Access {
    const saved = this.options.rememberConversationAccess && this.options.confirmAccess ? meta.accessGrant : undefined;
    const grant = this.conversationAccess.get(meta.id) ?? saved;
    return grant?.cwd === meta.cwd && (grant.level === 'edit' || grant.level === 'full') ? grant.level : 'read-only';
  }

  private async applyAccess(meta: ConversationMeta, level: Access, summary: string): Promise<void> {
    if (this.accessRequests.has(meta.id)) throw new Error('Já há uma confirmação de acesso pendente nesta conversa.');
    this.accessRequests.add(meta.id);
    try {
      if (level !== 'read-only' && RANK[level] > RANK[this.accessFor(meta)]) {
        const ok = await this.options.confirmAccess?.({ access: level, cwd: meta.cwd, summary });
        if (!ok) throw new Error('Write access was not confirmed, so nothing was started');
      }
      if (this.options.rememberConversationAccess && this.options.confirmAccess) {
        const grant = level === 'read-only' ? undefined : { cwd: meta.cwd, level };
        await this.store.setAccessGrant(meta.id, meta.cwd, grant);
      }
      // Keep revocations in memory too, so a concurrent request with older metadata sees the new level.
      this.conversationAccess.set(meta.id, { cwd: meta.cwd, level });
    } finally {
      this.accessRequests.delete(meta.id);
    }
  }

  async setConversationAccess(id: string, requested: Access): Promise<Access> {
    const level = access.parse(requested);
    const meta = await this.store.get(id);
    if (this.runs.isBusy(id)) throw new Error('Altere o acesso depois que a execução terminar.');
    if (this.accessRequests.has(id)) throw new Error('Já há uma confirmação de acesso pendente nesta conversa.');
    if (level !== this.accessFor(meta)) await this.applyAccess(meta, level, meta.title);
    return level;
  }
  private permissionsFor(meta: ConversationMeta): PermissionsView {
    const grant = this.permissionGrants.get(meta.id);
    return grant?.cwd === meta.cwd ? { ...grant.granted } : { web: false, browser: false };
  }

  async getPermissions(id: string): Promise<PermissionsView> {
    return this.permissionsFor(await this.store.get(id));
  }

  async setPermission(id: string, permission: PermissionKey, enabled: boolean): Promise<PermissionsView> {
    const key = z.enum(['web', 'browser']).parse(permission);
    const on = z.boolean().parse(enabled);
    const meta = await this.store.get(id);
    if (this.runs.isBusy(id)) throw new Error('Altere as permissões depois que a execução terminar.');
    if (this.permissionRequests.has(id)) throw new Error('Já há uma confirmação de permissão pendente nesta conversa.');
    const current = this.permissionsFor(meta);
    if (current[key] !== on) {
      this.permissionRequests.add(id);
      try {
        // Asked here, in the main process: the window is a web page and could claim the person said yes.
        if (on && !(await this.options.confirmPermission?.({ permission: key, cwd: meta.cwd, summary: meta.title }))) {
          throw new Error('Permission was not confirmed, so nothing changed');
        }
        current[key] = on;
        this.permissionGrants.set(id, { cwd: meta.cwd, granted: current });
      } finally {
        this.permissionRequests.delete(id);
      }
    }
    return this.permissionsFor(meta);
  }

  renameConversation(id: string, title: string): Promise<void> {
    return this.store.rename(id, title);
  }
  async deleteConversation(id: string): Promise<void> {
    if (this.runs.isBusy(id)) throw new Error('Cancel the running task first');
    if (this.accessRequests.has(id)) throw new Error('Feche a confirmação de acesso antes de apagar a conversa.');
    await this.store.remove(id);
    this.conversationAccess.delete(id);
    this.permissionGrants.delete(id);
    await this.journal.removeConversation(id);
  }

  async startRun(raw: StartRun): Promise<{ runId: string }> {
    return this.launchRun(raw);
  }

  private async launchRun(raw: StartRun, mobile?: { provider: ProviderId; authorized: () => boolean }): Promise<{ runId: string }> {
    const input = runSchema.parse(raw) as StartRun;
    if (!input.prompt && !input.attachments?.length) throw new Error('Write something first');
    if (input.attachments?.length && input.spec.kind !== 'lead' && input.spec.kind !== 'chat') throw new Error('Anexos estão disponíveis no chat.');
    input.prompt ||= ATTACHMENT_ONLY_PROMPT;
    const meta = await this.store.get(input.conversationId);
    if (!this.runs.canStart(meta.id, !!mobile)) throw new RunBusyError();
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
    if (this.accessRequests.has(meta.id)) throw new Error('Aguarde a confirmação de acesso desta conversa.');
    if (level !== 'read-only' && RANK[level] > RANK[this.accessFor(meta)]) {
      // Asked here, in the main process, because the window is a web page and could claim the person said yes.
      await this.applyAccess(meta, level,
          input.spec.kind === 'plan'
            ? `${input.spec.executor} will carry out the plan`
            : input.spec.kind === 'flow'
              ? `${input.spec.steps.filter((s) => s.kind === 'execute').map((s) => s.provider).join(', ')} will carry out step(s) that change files`
              : `${providersOf(input.spec).join(', ')} may act`);
    }
    if (this.options.updates?.state().phase === 'installing') throw new Error('O Big Three está reiniciando para atualizar.');
    if (mobile && !mobile.authorized()) throw new MobilePermissionError();
    // Runs started from the phone never get more than the default: a permission is granted at the desk.
    return { runId: await this.runs.start(input, meta.cwd, level !== 'read-only', mobile?.provider, mobile ? undefined : this.permissionsFor(meta)) };
  }

  async cancelRun(runId: string): Promise<void> {
    this.runs.cancel(runId);
  }

  async answerQuestion(runId: string, questionId: string, answer: string): Promise<void> {
    this.runs.answer(z.string().uuid().parse(runId), z.string().uuid().parse(questionId), z.string().trim().min(1).max(4000).parse(answer));
  }

  async usage(): Promise<Record<string, UsageView>> {
    return Object.fromEntries(
      Object.entries(this.usageTracker.snapshot()).map(([k, v]) => [
        k,
        { turns: v.turns, failures: v.failures, inputTokens: v.inputTokens, outputTokens: v.outputTokens, limitedUntil: v.limitedUntil, window: v.window, windows: v.windows },
      ]),
    );
  }

  async pickFolder(): Promise<string | null> {
    return (await this.options.pickFolder?.()) ?? null;
  }

  async accountQuotas(): Promise<AccountQuota[]> {
    // Coalesce refreshes and avoid polling an account endpoint on each UI update.
    if (this.quotaCache && Date.now() - this.quotaCache.at < 60000) return this.withObservedQuota(this.quotaCache.value);
    this.quotaRead ??= Promise.all((['claude', 'gemini', 'codex'] as const).map(async (provider): Promise<AccountQuota> => {
      const adapter = this.adapters[provider];
      if (adapter?.readQuota) {
        try {
          const windows = await adapter.readQuota();
          return { provider, source: windows.length ? 'account' : 'unavailable', checkedAt: Date.now(), windows,
            message: windows.length ? 'Cota informada pela conta conectada.' : 'A conta não forneceu janelas de cota.' };
        } catch { return { provider, source: 'unavailable', checkedAt: Date.now(), windows: [], message: 'Não foi possível consultar a cota. Confira o login e a versão da CLI.' }; }
      }
      return { provider, source: 'unavailable', windows: [], message: provider === 'claude'
        ? 'Os limites reportados pela CLI aparecem após uma execução. Confira a cota completa na plataforma.'
        : provider === 'gemini' ? 'Consulte a cota por modelo com /usage no Antigravity.' : 'Consulta de cota indisponível nesta CLI.' };
    })).then((value) => { this.quotaCache = { at: Date.now(), value }; return value; }).finally(() => { this.quotaRead = undefined; });
    return this.withObservedQuota(await this.quotaRead);
  }
  private withObservedQuota(quotas: AccountQuota[]): AccountQuota[] {
    const usage = this.usageTracker.snapshot();
    return quotas.map((quota) => {
      const windows = usage[quota.provider]?.windows;
      return quota.source === 'account' || !windows?.length ? quota : { ...quota, source: 'events',
        checkedAt: Math.max(...windows.map((window) => window.observedAt)),
        message: 'Últimos limites informados pela CLI durante execuções neste app.',
        windows: windows.map((window) => ({ ...window, name: window.name ?? 'Janela informada' })) };
    });
  }
}
