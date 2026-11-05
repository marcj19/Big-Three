import type { Access, DoneStatus, McpServerSpec, ProviderId, SubagentActivity } from '@aio/core';

export type Author = ProviderId | 'user' | 'system';

export interface RoomMessage {
  /** 1-based position in the transcript; assigned when read, so concurrent writers never collide. */
  index: number;
  author: Author;
  text: string;
  at: string;
}

export type NewMessage = Pick<RoomMessage, 'author' | 'text'>;

/** Where the transcript lives. A file-backed store lets the MCP peer server (another process) share it. */
export interface TranscriptStore {
  append(message: NewMessage): Promise<void>;
  list(): Promise<RoomMessage[]>;
}

export interface TurnUsage {
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
}

export interface TurnResult {
  provider: ProviderId;
  status: DoneStatus;
  /** The model's final answer; empty when the turn failed before producing one. */
  text: string;
  sessionId?: string;
  usage: TurnUsage;
  error?: string;
  /** The failure looks like a subscription limit, so trying another provider makes sense. */
  rateLimited: boolean;
}

/** What a UI needs to show a turn live. */
export type RoomEvent =
  | { type: 'turn_start'; provider: ProviderId; instruction: string }
  | { type: 'text'; provider: ProviderId; text: string; partial: boolean }
  | { type: 'tool_call'; provider: ProviderId; name: string }
  | { type: 'tool_result'; provider: ProviderId; name?: string; isError: boolean }
  | ({ type: 'subagent'; provider: ProviderId } & SubagentActivity)
  | { type: 'preview'; provider: ProviderId; url: string }
  | { type: 'limit'; provider: ProviderId; status: string; window?: string; resetsAt?: number; usedPercent?: number }
  | { type: 'turn_end'; result: TurnResult }
  | { type: 'skipped'; provider: ProviderId; reason: string };

export interface TurnOptions {
  /** Defaults to 'read-only'. Anything stronger must be asked for explicitly. */
  access?: Access;
  /** Applies to the first provider tried only: another model's name means nothing to a fallback provider. */
  model?: string;
  effort?: string;
  /** Continue this provider session (the first provider tried only). */
  sessionId?: string;
  /** With `sessionId`: the transcript position that session already knows; only later messages are sent again. */
  sinceIndex?: number;
  cwd?: string;
  signal?: AbortSignal;
  timeoutMs?: number;
  /** Extra system prompt for this turn (the role the participant plays). */
  role?: string;
  /** Give the model the room tools (`ask_peer`, `read_room`, `post_to_room`) when its CLI supports MCP injection. */
  withPeerTools?: boolean;
  /**
   * Other MCP servers for this turn (e.g. the database broker). Models whose CLI cannot take MCP servers
   * simply do not get them.
   */
  mcpServers?: McpServerSpec[];
  /** Keep the turn out of the transcript (e.g. a private scratch call). */
  record?: boolean;
}
