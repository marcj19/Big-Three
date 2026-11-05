/**
 * The contract between the window and the main process. Plain data only (it crosses an IPC boundary), and nothing
 * here can carry a password out of the app: passwords only ever travel from the window to the vault.
 */
export type ProviderId = 'claude' | 'gemini' | 'codex';
export type Access = 'read-only' | 'edit' | 'full';
export type Engine = 'postgres' | 'mysql' | 'oracle';
export type Verdict = 'approve' | 'changes' | 'unclear';

export interface ProviderStatus {
  id: ProviderId;
  displayName: string;
  available: boolean;
  version?: string;
  /** Why it is unavailable, with a hint on how to fix it. */
  reason?: string;
  signedIn: boolean | 'unknown';
  canLogin: boolean;
  /** Whether this model can be given the database and the ask_peer tools. */
  supportsMcp: boolean;
  /** Efforts this model's CLI takes separately from the model name (empty when the effort is part of the model). */
  efforts: string[];
}

export interface ModelOption {
  id: string;
  label: string;
  note?: string;
}

export type StepKind = 'answer' | 'plan' | 'execute' | 'review' | 'revise' | 'debate';

export interface FlowMember {
  provider: ProviderId;
  model?: string;
  effort?: string;
}

export interface FlowStep {
  kind: StepKind;
  provider: ProviderId;
  model?: string;
  effort?: string;
  /** Required for `execute`. */
  access?: Access;
  members?: FlowMember[];
  rounds?: number;
}

export type StepStatus = 'running' | 'done' | 'skipped' | 'error' | 'cancelled';

export interface StepEventView {
  index: number;
  total: number;
  kind: StepKind;
  provider: ProviderId;
  status: StepStatus;
  note?: string;
  error?: string;
}

export interface ConnectionInput {
  name: string;
  engine: Engine;
  host: string;
  port?: number;
  database: string;
  user: string;
  ssl?: boolean;
}

export interface ConnectionView extends ConnectionInput {
  port: number;
  /** Whether a password is stored in the system vault. The password itself is never sent to the window. */
  hasPassword: boolean;
}

export interface ConversationMeta {
  id: string;
  title: string;
  cwd: string;
  createdAt: string;
  updatedAt: string;
  /** Each model's own CLI session in this conversation, and how much of the transcript it has already seen. */
  sessions?: Partial<Record<ProviderId, { id: string; upto: number }>>;
}

/** A model with the choices made for it. */
export interface ModelChoice {
  provider: ProviderId;
  model?: string;
  effort?: string;
}

export interface MessageView {
  index: number;
  author: ProviderId | 'user' | 'system';
  text: string;
  at: string;
}

export type RunSpec =
  /** One model answers; several are a fallback order. */
  | { kind: 'chat'; providers: ProviderId[]; access: Access }
  | { kind: 'review'; author: ProviderId; reviewer: ProviderId }
  | { kind: 'plan'; planner: ProviderId; executor: ProviderId; reviewer?: ProviderId; executorAccess: Access }
  | { kind: 'debate'; participants: ProviderId[]; rounds?: number; judge?: ProviderId }
  /**
   * One model leads and decides for itself when to consult the team (read-only teammates, on the models given here).
   * This is how a normal chat works: pick a model, write, and the lead orchestrates what it needs.
   */
  | { kind: 'lead'; lead: ModelChoice; access: Access; team: ModelChoice[]; fallback: boolean }
  /** A list of steps, each with its own model. The other kinds are particular lists of steps. */
  | { kind: 'flow'; steps: FlowStep[]; fallback: boolean };

export interface StartRun {
  conversationId: string;
  prompt: string;
  spec: RunSpec;
  /** Database connections the models may query (read-only). Models that cannot take MCP servers ignore them. */
  connections: string[];
  /** Let Claude and Codex ask the other participants questions mid-turn. */
  peerTools: boolean;
}

export interface RunOutcome {
  status: 'ok' | 'error' | 'cancelled';
  final: string;
  verdict?: Verdict;
  error?: string;
}

export interface UsageView {
  turns: number;
  failures: number;
  inputTokens: number;
  outputTokens: number;
  limitedUntil?: number;
  window?: { status: string; name?: string; resetsAt?: number };
  windows?: { status: string; name?: string; resetsAt?: number; usedPercent?: number; observedAt: number }[];
}

export interface AccountQuota {
  provider: ProviderId;
  source: 'account' | 'events' | 'unavailable';
  checkedAt?: number;
  message: string;
  windows: { name: string; usedPercent?: number; resetsAt?: number; status?: string; observedAt?: number }[];
}

export interface ConnectionTest {
  ok: boolean;
  tables?: number;
  error?: string;
}

export type LoginEventView = { type: 'output'; line: string } | { type: 'done'; ok: boolean; message?: string };

export type RoomEventView =
  | { type: 'turn_start'; provider: ProviderId; instruction: string }
  | { type: 'text'; provider: ProviderId; text: string; partial: boolean }
  | { type: 'tool_call'; provider: ProviderId; name: string }
  | { type: 'tool_result'; provider: ProviderId; name?: string; isError: boolean }
  | { type: 'limit'; provider: ProviderId; status: string; window?: string; resetsAt?: number; usedPercent?: number }
  | { type: 'skipped'; provider: ProviderId; reason: string }
  | { type: 'turn_end'; provider: ProviderId; status: 'ok' | 'error' | 'cancelled'; error?: string; inputTokens: number; outputTokens: number };

export type AppEvent =
  | { type: 'browser'; state: BrowserState }
  | { type: 'login'; provider: ProviderId; event: LoginEventView }
  | { type: 'peer_activity'; runId: string; conversationId: string; self: ProviderId; peer: ProviderId; activity: 'thinking' | 'writing' | 'tool' | 'done' | 'error' | 'cancelled'; tool?: string }
  | { type: 'room'; runId: string; conversationId: string; event: RoomEventView }
  | { type: 'step'; runId: string; conversationId: string; step: StepEventView }
  | { type: 'run_done'; runId: string; conversationId: string; outcome: RunOutcome };

export interface Api {
  providersStatus(): Promise<ProviderStatus[]>;
  /** Models a provider offers (the first entry is the account default). Costs no quota. */
  listModels(id: ProviderId): Promise<ModelOption[]>;
  loginProvider(id: ProviderId): Promise<void>;
  cancelLogin(id: ProviderId): Promise<void>;

  listConnections(): Promise<ConnectionView[]>;
  saveConnection(input: ConnectionInput): Promise<void>;
  deleteConnection(name: string): Promise<void>;
  /** Write-only: stores the password in the system vault and forgets it. */
  setPassword(name: string, password: string): Promise<void>;
  clearPassword(name: string): Promise<void>;
  testConnection(name: string): Promise<ConnectionTest>;

  listConversations(): Promise<ConversationMeta[]>;
  createConversation(input: { cwd: string; title?: string }): Promise<ConversationMeta>;
  getConversation(id: string): Promise<{ meta: ConversationMeta; messages: MessageView[] }>;
  renameConversation(id: string, title: string): Promise<void>;
  deleteConversation(id: string): Promise<void>;

  startRun(input: StartRun): Promise<{ runId: string }>;
  cancelRun(runId: string): Promise<void>;
  usage(): Promise<Record<string, UsageView>>;
  accountQuotas(): Promise<AccountQuota[]>;

  /** Native folder picker; null when cancelled or unavailable. */
  pickFolder(): Promise<string | null>;
  workspaceDirectory(conversationId: string, relativePath?: string): Promise<WorkspaceDirectory>;
  workspaceFile(conversationId: string, relativePath: string): Promise<WorkspaceFile>;
  runHistory(conversationId: string): Promise<RunRecord[]>;
  browserState(): Promise<BrowserState>;
  browserNavigate(url: string): Promise<void>;
  browserCommand(command: 'back' | 'forward' | 'reload' | 'stop'): Promise<void>;
  browserBounds(bounds: BrowserBounds): Promise<void>;
}

export type ApiMethod = keyof Api;

/** Every method name, for wiring the IPC channels. Kept in sync with `Api` by the type below. */
export const API_METHODS = [
  'providersStatus',
  'listModels',
  'loginProvider',
  'cancelLogin',
  'listConnections',
  'saveConnection',
  'deleteConnection',
  'setPassword',
  'clearPassword',
  'testConnection',
  'listConversations',
  'createConversation',
  'getConversation',
  'renameConversation',
  'deleteConversation',
  'startRun',
  'cancelRun',
  'usage',
  'accountQuotas',
  'pickFolder',
  'workspaceDirectory', 'workspaceFile', 'runHistory', 'browserState', 'browserNavigate', 'browserCommand', 'browserBounds',
] as const satisfies readonly ApiMethod[];

// Fails to compile if a method was added to `Api` but not to API_METHODS.
type Missing = Exclude<ApiMethod, (typeof API_METHODS)[number]>;
export const _allMethodsListed: Missing extends never ? true : never = true;

export interface WorkspaceEntry { name: string; path: string; kind: 'directory' | 'file' | 'link' }
export interface WorkspaceDirectory { path: string; entries: WorkspaceEntry[]; truncated: boolean }
export interface WorkspaceFile { path: string; text: string; bytes: number; truncated: boolean; binary: boolean }
export interface BrowserBounds { visible: boolean; x: number; y: number; width: number; height: number }
export interface BrowserState { supported: boolean; url: string; title: string; loading: boolean; canBack: boolean; canForward: boolean; error?: string }
export interface WorkEntry {
  id: number; at: string; kind: 'start' | 'phase' | 'tool' | 'consult' | 'step' | 'finish' | 'notice';
  provider?: ProviderId; peer?: ProviderId; status: 'running' | 'done' | 'error' | 'cancelled' | 'skipped';
  label: string; detail?: string; tool?: string; stepIndex?: number;
}
export interface RunRecord {
  id: string; conversationId: string; prompt: string; startedAt: string; endedAt?: string;
  status: 'running' | 'ok' | 'error' | 'cancelled'; entries: WorkEntry[]; inputTokens: number; outputTokens: number;
}
