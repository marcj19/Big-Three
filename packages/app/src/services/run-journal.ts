import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import type { AppEvent, RunRecord, StartRun } from '../shared/api.js';
import { newRunRecord, recordWork } from '../shared/work-trace.js';

const id = z.string().uuid();
const provider = z.enum(['claude', 'gemini', 'codex']);
const storedRun = z.object({ id, conversationId: id, prompt: z.string().max(400), startedAt: z.string(), endedAt: z.string().optional(),
  status: z.enum(['running', 'ok', 'error', 'cancelled']), inputTokens: z.number().nonnegative(), outputTokens: z.number().nonnegative(),
  previewUrl: z.string().optional(),
  entries: z.array(z.object({ id: z.number().int(), at: z.string(), kind: z.enum(['start', 'phase', 'tool', 'consult', 'subagent', 'question', 'step', 'finish', 'notice']),
    provider: provider.optional(), peer: provider.optional(), status: z.enum(['running', 'done', 'error', 'cancelled', 'skipped']), label: z.string(), detail: z.string().optional(),
    tool: z.string().optional(), context: z.string().max(180).optional(), stepIndex: z.number().int().optional(), activityId: z.string().optional() })).max(500),
});

export class RunJournal {
  private readonly records = new Map<string, RunRecord>();
  constructor(private readonly dir: string) {}
  begin(id: string, input: StartRun): void { this.records.set(id, newRunRecord(id, input)); }
  event(id: string, event: AppEvent): void { const record = this.records.get(id); if (record) recordWork(record, event); }
  async save(id: string): Promise<void> {
    const record = this.records.get(id);
    if (!record) return;
    const dir = path.join(this.dir, record.conversationId);
    await mkdir(dir, { recursive: true });
    const file = path.join(dir, `${id}.json`), temporary = `${file}.tmp`;
    await writeFile(temporary, JSON.stringify(record), { mode: 0o600 });
    await rename(temporary, file);
    // Bound memory; completed runs remain available on disk.
    if (this.records.size > 100) for (const [key, value] of this.records) if (value.status !== 'running' && key !== id) { this.records.delete(key); break; }
  }
  async list(conversationId: string, limit = 50): Promise<RunRecord[]> {
    const all = new Map(this.records);
    const dir = path.join(this.dir, conversationId);
    const files = await readdir(dir).catch(() => [] as string[]);
    const recent = (await Promise.all(files.filter((name) => /^[0-9a-f-]{36}\.json$/.test(name)).map(async (name) => ({ name, time: await stat(path.join(dir, name)).then((info) => info.mtimeMs, () => 0) }))))
      .sort((a, b) => b.time - a.time).slice(0, limit);
    const sorted = await Promise.all(recent.map(async ({ name }) => {
      try {
        if ((await stat(path.join(dir, name))).size > 1_000_000) return undefined;
        const raw = await readFile(path.join(dir, name), 'utf8');
        if (raw.length > 1_000_000) return undefined;
        const record = storedRun.safeParse(JSON.parse(raw));
        return record.success && record.data.id === name.slice(0, -5) && record.data.conversationId === conversationId ? record.data : undefined;
      } catch { return undefined; }
    }));
    for (const record of sorted) if (record && !all.has(record.id)) all.set(record.id, record);
    return [...all.values()].filter((record) => record.conversationId === conversationId).sort((a, b) => b.startedAt.localeCompare(a.startedAt)).slice(0, limit);
  }
  async removeConversation(conversationId: string): Promise<void> {
    id.parse(conversationId);
    for (const [key, record] of this.records) if (record.conversationId === conversationId) this.records.delete(key);
    const root = path.resolve(this.dir), target = path.resolve(root, conversationId);
    if (path.dirname(target) !== root) throw new Error('Invalid run history path');
    await rm(target, { recursive: true, force: true });
  }
}
