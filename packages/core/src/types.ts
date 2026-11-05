export type ProviderId = 'claude' | 'gemini' | 'codex';

export interface QuotaWindow {
  name: string;
  usedPercent?: number;
  resetsAt?: number;
  status?: string;
}

/** How much the model may do on its own. Maps to each CLI's own permission mode. */
export type Access = 'read-only' | 'edit' | 'full';

export interface McpServerSpec {
  name: string;
  command: string;
  args?: string[];
  /** Written to a config file the model could read: never put secrets here. */
  env?: Record<string, string>;
}

/** A model a CLI can run. An empty `id` means "whatever the account uses by default". */
export interface ModelOption {
  id: string;
  label: string;
  /** Short hint shown next to the name, e.g. "most capable". */
  note?: string;
}

export interface RunRequest {
  prompt: string;
  cwd: string;
  /** Defaults to 'read-only'. */
  access?: Access;
  model?: string;
  /** Reasoning effort for CLIs that take it separately from the model (e.g. low, medium, high). */
  effort?: string;
  /** Provider session to continue (only for adapters with `supportsResume`). */
  sessionId?: string;
  systemPrompt?: string;
  mcpServers?: McpServerSpec[];
  signal?: AbortSignal;
  timeoutMs?: number;
}

export type DoneStatus = 'ok' | 'error' | 'cancelled';

export type AgentEvent =
  | { type: 'session'; sessionId: string }
  /** `partial` marks streaming deltas; non-partial text is a complete assistant message. */
  | { type: 'text'; text: string; partial?: boolean }
  | { type: 'tool_call'; name: string; input?: unknown }
  | { type: 'tool_result'; name?: string; isError?: boolean }
  | { type: 'usage'; inputTokens?: number; outputTokens?: number; costUsd?: number }
  /** Subscription-limit state the CLI reported. `resetsAt` is epoch milliseconds. */
  | { type: 'limit'; status: string; window?: string; resetsAt?: number; usedPercent?: number }
  | { type: 'error'; message: string }
  /** Always the last event of a run. */
  | { type: 'done'; status: DoneStatus; text?: string };

export interface Availability {
  available: boolean;
  version?: string;
  /** Why it is unavailable, with a hint on how to fix it. */
  reason?: string;
}

export interface AuthStatus {
  /** `'unknown'` when the CLI offers no way to check without spending quota. */
  signedIn: boolean | 'unknown';
  detail?: string;
}

export type LoginEvent =
  /** A line the CLI printed, e.g. the sign-in URL if the browser did not open. */
  | { type: 'output'; line: string }
  | { type: 'done'; ok: boolean; message?: string };

export interface Adapter {
  readonly id: ProviderId;
  readonly displayName: string;
  readonly supportsResume: boolean;
  /** Whether `RunRequest.mcpServers` is honoured; adapters that cannot inject MCP servers throw if given any. */
  readonly supportsMcp: boolean;
  /** Whether `login()` can start the sign-in flow from the app. */
  readonly canLogin: boolean;
  /** Efforts the CLI accepts with `RunRequest.effort`; empty when the effort is part of the model id. */
  readonly efforts: readonly string[];
  /** Models to offer in a picker. Costs no quota; the first entry is the account default. */
  listModels(): Promise<ModelOption[]>;
  /** Read account quotas without starting a model turn, when the CLI supports it. */
  readQuota?(): Promise<QuotaWindow[]>;
  detect(): Promise<Availability>;
  authStatus(): Promise<AuthStatus>;
  /** Starts the CLI's own browser sign-in. The app never sees the password or tokens. */
  login(signal?: AbortSignal): AsyncGenerator<LoginEvent, void>;
  run(req: RunRequest): AsyncGenerator<AgentEvent, void>;
}
