import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { FileTranscript, type RoomAttachment } from '@aio/room';
import { ATTACHMENT_FILE_LIMIT, ATTACHMENT_TOTAL_LIMIT, type AttachmentUpload, type ConversationMeta, type MessageView, type ProviderId } from '../shared/api.js';

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
    // Windows can briefly hold the destination open during a concurrent read or virus scan.
    // Keep the previous index intact and retry the atomic replacement, rather than truncating it.
    for (let attempt = 0; ; attempt++) {
      try { await rename(tmp, this.indexFile); break; }
      catch (err) {
        if (process.platform !== 'win32' || attempt >= 5 || !['EPERM', 'EACCES', 'EBUSY'].includes((err as NodeJS.ErrnoException).code ?? '')) throw err;
        await new Promise((resolve) => setTimeout(resolve, 30 * (attempt + 1)));
      }
    }
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

  setAccessGrant(id: string, cwd: string, grant: ConversationMeta['accessGrant']): Promise<void> {
    return this.update(id, (meta) => {
      if (meta.cwd !== cwd) throw new Error('A pasta da conversa mudou. Selecione o acesso novamente.');
      return { ...meta, accessGrant: grant };
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
      const root = path.resolve(this.dir);
      const attachments = path.join(root, `${id}-attachments`);
      if (path.dirname(attachments) === root) await rm(attachments, { recursive: true, force: true });
    });
  }

  transcript(id: string): FileTranscript {
    this.checkId(id);
    return new FileTranscript(path.join(this.dir, `${id}.jsonl`));
  }

  async messages(id: string): Promise<MessageView[]> {
    return (await this.transcript(id).list()).map((m) => ({ index: m.index, author: m.author, text: m.text, at: m.at,
      ...(m.attachments?.length ? { attachments: m.attachments.map((file) => file.name) } : {}), ...(m.runId ? { runId: m.runId } : {}) }));
  }

  async saveAttachments(id: string, uploads: AttachmentUpload[]): Promise<RoomAttachment[]> {
    this.checkId(id);
    if (!uploads.length) return [];
    let total = 0;
    const files = uploads.map(({ name, data }) => {
      const bytes = Buffer.from(data, 'base64');
      if (bytes.toString('base64') !== data || bytes.length > ATTACHMENT_FILE_LIMIT) throw new Error('Arquivo inválido ou maior que 10 MB.');
      total += bytes.length;
      return { name, bytes };
    });
    if (total > ATTACHMENT_TOTAL_LIMIT) throw new Error('Os anexos somam mais de 25 MB.');
    const dir = path.resolve(this.dir, `${id}-attachments`);
    await mkdir(dir, { recursive: true, mode: 0o700 });
    const saved: RoomAttachment[] = [];
    try {
      for (const { name, bytes } of files) {
        const ext = path.extname(name);
        const file = path.join(dir, randomUUID() + (/^\.[a-z0-9]{1,12}$/i.test(ext) ? ext : ''));
        saved.push({ name, path: file });
        await writeFile(file, bytes, { flag: 'wx', mode: 0o600 });
      }
      return saved;
    } catch (err) {
      await Promise.allSettled(saved.map(({ path: file }) => rm(file, { force: true })));
      throw err;
    }
  }
}
