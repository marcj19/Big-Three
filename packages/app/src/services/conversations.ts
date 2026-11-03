import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { FileTranscript } from '@aio/room';
import type { ConversationMeta, MessageView, ProviderId } from '../shared/api.js';

const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export const DEFAULT_TITLE = 'Nova conversa';

/** The first words of a prompt, cut at a word boundary. */
export function titleFrom(prompt: string, max = 48): string {
  const text = prompt.trim().replace(/\s+/g, ' ');
  if (text.length <= max) return text;
  const cut = text.slice(0, max);
  const at = cut.lastIndexOf(' ');
  return `${(at > max / 2 ? cut.slice(0, at) : cut).replace(/[\s,.;:!?-]+$/, '')}…`;
}

/**
 * Conversations are rooms on disk: an index plus one JSONL transcript each. Ids come from the window, so they are
 * checked before they ever become part of a path.
 */
export class ConversationStore {
  private readonly indexFile: string;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly dir: string) {
    this.indexFile = path.join(dir, 'index.json');
  }

  /** Index updates run one at a time, so two quick changes cannot overwrite each other. */
  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.queue.then(fn, fn);
    this.queue = next.catch(() => undefined);
    return next;
  }

  private async readIndex(): Promise<ConversationMeta[]> {
    try {
      return JSON.parse(await readFile(this.indexFile, 'utf8')) as ConversationMeta[];
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw err;
    }
  }

  private async writeIndex(list: ConversationMeta[]): Promise<void> {
    await mkdir(this.dir, { recursive: true });
    const tmp = `${this.indexFile}.${process.pid}.tmp`;
    await writeFile(tmp, JSON.stringify(list, null, 2));
    await rename(tmp, this.indexFile);
  }

  private checkId(id: string): void {
    if (!ID.test(id)) throw new Error('Invalid conversation id');
  }

  async list(): Promise<ConversationMeta[]> {
    return (await this.readIndex()).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  async get(id: string): Promise<ConversationMeta> {
    this.checkId(id);
    const meta = (await this.readIndex()).find((c) => c.id === id);
    if (!meta) throw new Error('Conversation not found');
    return meta;
  }

  create(input: { cwd: string; title?: string }): Promise<ConversationMeta> {
    return this.serial(async () => {
      const now = new Date().toISOString();
      const meta: ConversationMeta = { id: randomUUID(), title: input.title?.trim() || DEFAULT_TITLE, cwd: input.cwd, createdAt: now, updatedAt: now };
      await this.writeIndex([...(await this.readIndex()), meta]);
      return meta;
    });
  }

  async update(id: string, change: (meta: ConversationMeta) => ConversationMeta): Promise<void> {
    this.checkId(id);
    return this.serial(async () => {
      const list = await this.readIndex();
      const i = list.findIndex((c) => c.id === id);
      if (i < 0) throw new Error('Conversation not found');
      list[i] = change(list[i]!);
      await this.writeIndex(list);
    });
  }

  /** Remembers the model's own session so the next turn continues it instead of starting over. */
  setSession(id: string, provider: ProviderId, session: { id: string; upto: number } | undefined): Promise<void> {
    return this.update(id, (m) => {
      const sessions = { ...m.sessions };
      if (session) sessions[provider] = session;
      else delete sessions[provider];
      return { ...m, sessions };
    });
  }

  async rename(id: string, title: string): Promise<void> {
    const clean = title.trim().slice(0, 120);
    if (!clean) throw new Error('The title cannot be empty');
    return this.update(id, (m) => ({ ...m, title: clean }));
  }

  /** Marks activity; the first prompt names an untitled conversation. */
  touch(id: string, firstPrompt?: string): Promise<void> {
    return this.update(id, (m) => ({
      ...m,
      title: m.title === DEFAULT_TITLE && firstPrompt ? titleFrom(firstPrompt) || m.title : m.title,
      updatedAt: new Date().toISOString(),
    }));
  }

  async remove(id: string): Promise<void> {
    this.checkId(id);
    return this.serial(async () => {
      await this.writeIndex((await this.readIndex()).filter((c) => c.id !== id));
      await rm(path.join(this.dir, `${id}.jsonl`), { force: true });
    });
  }

  transcript(id: string): FileTranscript {
    this.checkId(id);
    return new FileTranscript(path.join(this.dir, `${id}.jsonl`));
  }

  async messages(id: string): Promise<MessageView[]> {
    return (await this.transcript(id).list()).map((m) => ({ index: m.index, author: m.author, text: m.text, at: m.at }));
  }
}
