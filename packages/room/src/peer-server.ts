import type { Adapter, Permissions, ProviderId } from '@aio/core';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { inlineFiles, MAX_FILES } from './peer-files.js';
import { NAMES } from './prompt.js';
import type { Team } from './peer-launch.js';
import { Room } from './room.js';
import { renderTranscript } from './transcript.js';
import type { TranscriptStore, TurnResult } from './types.js';
import { UsageTracker } from './usage.js';
import { peerActivityReporter, type PeerActivity } from './peer-activity.js';

export interface PeerServerOptions {
  /** The model this server is handed to. */
  self: ProviderId;
  /** Who it may ask. */
  peers: ProviderId[];
  adapters: Partial<Record<ProviderId, Adapter>>;
  transcript: TranscriptStore;
  cwd: string;
  /** Hard cap on questions over this server's lifetime (one model turn). */
  maxAsks: number;
  askTimeoutMs?: number;
  signal?: AbortSignal;
  /** Model and effort each teammate answers with (the lead cannot change them). */
  team?: Team;
  usage?: UsageTracker;
  onActivity?: (event: PeerActivity) => void;
  /** What the colleagues may reach. Only the lead's web permission is ever passed on. */
  permissions?: Permissions;
  /** Called after every consultation with what the colleague used, whatever the outcome. */
  onConsult?: (consult: { peer: ProviderId; result: TurnResult }) => void;
}

const MAX_POST_CHARS = 8_000;

const asText = (text: string) => ({ content: [{ type: 'text' as const, text }] });
const asError = (text: string) => ({ isError: true, content: [{ type: 'text' as const, text }] });

/**
 * The tools one model gets to use the room. Whatever a peer is asked runs read-only, without any MCP server of its
 * own, so a question can never fan out into more questions and a peer can never be talked into editing files.
 */
export function createPeerServer(options: PeerServerOptions): McpServer {
  const { self, peers } = options;
  const report = options.onActivity ? peerActivityReporter(self, options.onActivity) : undefined;
  const room = new Room({ adapters: options.adapters, cwd: options.cwd, transcript: options.transcript, usage: options.usage,
    onEvent: (event) => { if (event.type !== 'turn_end') report?.(event); } });
  let asks = 0;

  const server = new McpServer({ name: 'aio-room', version: '0.1.0' });

  server.registerTool(
    'read_room',
    { description: 'Read the shared room transcript: what the user and the other participants said so far.' },
    async () => asText(renderTranscript(await options.transcript.list())),
  );

  server.registerTool(
    'post_to_room',
    {
      description: 'Add a message to the shared room so the other participants (and the user) can see it.',
      inputSchema: { text: z.string().min(1).describe('The message') },
    },
    async ({ text }: { text: string }) => {
      if (options.signal?.aborted) return asError('Consulta cancelada.');
      if (text.length > MAX_POST_CHARS) return asError(`Message is too long (${text.length} characters, the limit is ${MAX_POST_CHARS})`);
      await options.transcript.append({ author: self, text });
      return asText('Posted.');
    },
  );

  server.registerTool(
    'ask_peer',
    {
      description: `Ask another participant one focused question and get their answer (${peers.map((p) => NAMES[p]).join(', ')}). They can read the room and the project files but cannot change anything. Slow and uses their subscription quota: ask only when a second opinion changes what you do.`,
      inputSchema: {
        peer: z.enum(peers as [ProviderId, ...ProviderId[]]).describe('Who to ask'),
        question: z.string().min(1).describe('A self-contained question'),
        files: z.array(z.string().min(1)).max(MAX_FILES).optional()
          .describe('Project files (paths relative to the project folder) to send along with the question, so the colleague answers from them straight away instead of searching. Use it for the files the question is about.'),
      },
    },
    async ({ peer, question, files }: { peer: ProviderId; question: string; files?: string[] }, { signal: requestSignal }) => {
      const signal = options.signal ? AbortSignal.any([options.signal, requestSignal]) : requestSignal;
      if (signal.aborted) return asError('Consulta cancelada.');
      if (peer === self) return asError('You cannot ask yourself.');
      if (!peers.includes(peer)) return asError(`${peer} is not available in this room.`);
      if (asks >= options.maxAsks) return asError(`Question limit reached (${options.maxAsks}). Work with what you have.`);
      asks++;

      await options.transcript.append({ author: self, text: `(to ${peer}) ${question}` });
      // The files go into this one instruction only, never the shared transcript: they would be re-sent on every turn.
      const attached = await inlineFiles(options.cwd, files);
      const result = await room.turn(peer, `${NAMES[self]} asks you: ${question}\nAnswer only that question, briefly.${attached.text}`, {
        access: 'read-only',
        permissions: options.permissions?.web ? { web: true } : undefined,
        model: options.team?.[peer]?.model || undefined,
        effort: options.team?.[peer]?.effort || undefined,
        timeoutMs: options.askTimeoutMs ?? 180_000,
        signal,
      });
      report?.({ type: 'turn_end', result });
      options.onConsult?.({ peer, result });
      const skipped = attached.skipped.length ? `\n\n(Not sent to ${NAMES[peer]}: ${attached.skipped.join('; ')})` : '';
      return result.status === 'ok' ? asText(result.text + skipped)
        : result.status === 'cancelled' ? asError('Consulta cancelada.')
          : asError(`${NAMES[peer]} could not answer: ${result.error ?? 'unknown error'}`);
    },
  );

  return server;
}
