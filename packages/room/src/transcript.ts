import { appendFile, mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import type { Author, NewMessage, RoomMessage, TranscriptStore } from './types.js';

const AUTHORS: ReadonlySet<string> = new Set(['claude', 'gemini', 'codex', 'user', 'system']);

export class MemoryTranscript implements TranscriptStore {
  private readonly messages: RoomMessage[] = [];

  async append(message: NewMessage): Promise<void> {
    this.messages.push({ ...message, index: this.messages.length + 1, at: new Date().toISOString() });
  }

  async list(): Promise<RoomMessage[]> {
    return this.messages.map((m) => ({ ...m }));
  }
}

/**
 * One JSON object per line. Appends are single small writes, so the orchestrator and the peer server can both
 * write without locking; order is file order.
 */
export class FileTranscript implements TranscriptStore {
  constructor(readonly file: string) {}

  async append(message: NewMessage): Promise<void> {
    await mkdir(path.dirname(this.file), { recursive: true });
    await appendFile(this.file, JSON.stringify({ ...message, at: new Date().toISOString() }) + '\n');
  }

  async list(): Promise<RoomMessage[]> {
    let raw: string;
    try {
      raw = await readFile(this.file, 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw err;
    }
    const messages: RoomMessage[] = [];
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue;
      try {
        const o = JSON.parse(line) as { author?: unknown; text?: unknown; at?: unknown; attachments?: unknown };
        if (typeof o.author !== 'string' || !AUTHORS.has(o.author) || typeof o.text !== 'string') continue;
        const attachments = o.author === 'user' && Array.isArray(o.attachments)
          ? o.attachments.filter((file) => typeof file?.name === 'string' && typeof file?.path === 'string' && path.isAbsolute(file.path)) : [];
        messages.push({ index: messages.length + 1, author: o.author as Author, text: o.text, at: typeof o.at === 'string' ? o.at : '',
          ...(attachments.length ? { attachments } : {}) });
      } catch {
        // A torn or foreign line must not take the whole room down.
      }
    }
    return messages;
  }
}

export interface RenderOptions {
  /** Total characters for the rendered transcript. */
  budget: number;
  /** One message is cut to this many characters. */
  perMessage: number;
}

export const DEFAULT_RENDER: RenderOptions = { budget: 12_000, perMessage: 4_000 };

function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}\n[... ${text.length - max} more characters cut]`;
}

/**
 * Renders the transcript for a prompt. The first message (the original task) is always kept, then the newest
 * messages that fit; the gap is marked so the model knows context is missing.
 */
export function renderTranscript(messages: RoomMessage[], options: Partial<RenderOptions> = {}): string {
  const { budget, perMessage } = { ...DEFAULT_RENDER, ...options };
  const line = (m: RoomMessage) => `[${m.index}] ${m.author}:\n${clip(m.text, perMessage)}${m.attachments?.length
    ? '\nUser attachments (inspect these local files if relevant):\n' + m.attachments.map((file) => JSON.stringify({ name: file.name, path: file.path })).join('\n') : ''}`;
  if (messages.length === 0) return '(the room is empty)';

  const first = messages[0]!;
  const kept: RoomMessage[] = [];
  let used = line(first).length;
  for (let i = messages.length - 1; i >= 1; i--) {
    const size = line(messages[i]!).length + 2;
    if (used + size > budget) break;
    used += size;
    kept.unshift(messages[i]!);
  }
  const omitted = messages.length - 1 - kept.length;
  const parts = [line(first)];
  if (omitted > 0) parts.push(`[... ${omitted} earlier message${omitted === 1 ? '' : 's'} omitted]`);
  parts.push(...kept.map(line));
  return parts.join('\n\n');
}
