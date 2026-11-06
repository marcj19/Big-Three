import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { stat, writeFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { browserUrl } from '../src/shared/browser-url.js';
import { newRunRecord, recordWork, runsByMessage, timelineEntries } from '../src/shared/work-trace.js';
import { RunJournal } from '../src/services/run-journal.js';
import type { AppEvent, MessageView, StartRun } from '../src/shared/api.js';
import { tmp } from './helpers.js';

const input = (): StartRun => ({ conversationId: randomUUID(), prompt: 'Implemente uma feature', spec: { kind: 'chat', providers: ['claude'], access: 'read-only' }, connections: [], peerTools: true });
const room = (runId: string, conversationId: string, event: Extract<AppEvent, { type: 'room' }>['event']): AppEvent => ({ type: 'room', runId, conversationId, event });
describe('browser navigation policy', () => {
  it('accepts websites and local previews, but refuses executable schemes and embedded credentials', () => {
    expect(browserUrl('example.com')).toBe('https://example.com/');
    expect(browserUrl('localhost:3000/path')).toBe('http://localhost:3000/path');
    expect(browserUrl('http://127.0.0.1:4173')).toBe('http://127.0.0.1:4173/');
    for (const url of ['javascript:alert(1)', 'file:///C:/secret', 'data:text/html,test', 'about:blank', 'https://user:pass@example.com', 'https://exa mple.com']) expect(() => browserUrl(url)).toThrow();
  });
});
describe('execution journal', () => {
  it('attaches one card per run even when messages repeat, preferring an explicit run ID', () => {
    const task = input();
    const at = (second: number) => new Date(1000 * second).toISOString();
    const first = newRunRecord(randomUUID(), task, at(4));
    const second = newRunRecord(randomUUID(), task, at(9));
    const linked = newRunRecord(randomUUID(), task, at(12));
    const message = (index: number, second: number): MessageView => ({ index, at: at(second), author: 'user', text: task.prompt });
    const a = message(1, 5), b = message(2, 10), unmatched = message(3, 13);
    const exact = { ...message(4, 45), runId: linked.id };
    const matches = runsByMessage([a, b, unmatched, exact], [linked, second, first]);
    expect([matches.get(a), matches.get(b), matches.get(unmatched), matches.get(exact)]).toEqual([first, second, undefined, linked]);
  });

  it('records observed tools and peer cooperation without copying model answer contents', () => {
    const task = input(), id = randomUUID(), run = newRunRecord(id, task);
    recordWork(run, room(id, task.conversationId, { type: 'turn_start', provider: 'claude', instruction: 'private system instruction' }));
    recordWork(run, room(id, task.conversationId, { type: 'tool_call', provider: 'claude', name: 'read_file', context: 'src/app.ts' }));
    recordWork(run, room(id, task.conversationId, { type: 'tool_result', provider: 'claude', name: 'read_file', isError: false }));
    for (const activity of ['thinking', 'writing', 'done'] as const) recordWork(run, { type: 'peer_activity', runId: id, conversationId: task.conversationId, self: 'claude', peer: 'gemini', activity });
    for (let i = 0; i < 50; i++) recordWork(run, room(id, task.conversationId, { type: 'text', provider: 'claude', text: 'private output', partial: true }));
    recordWork(run, { type: 'run_done', runId: id, conversationId: task.conversationId, outcome: { status: 'ok', final: 'private final' } });
    expect(run.entries.filter((entry) => entry.kind === 'consult')).toHaveLength(1);
    expect(timelineEntries(run).map((entry) => entry.kind)).toEqual(['start', 'tool', 'consult', 'finish']);
    expect(run.entries.find((entry) => entry.kind === 'tool')).toMatchObject({ status: 'done', label: 'Lendo arquivos', context: 'src/app.ts' });
    expect(run.status).toBe('ok'); expect(run.entries.filter((entry) => entry.status === 'running')).toHaveLength(0);
    expect(JSON.stringify(run)).not.toContain('private');
  });
  it('persists history across app instances, isolates conversations and deletes their records', async () => {
    const dir = await tmp(), journal = new RunJournal(dir), task = input(), id = randomUUID();
    journal.begin(id, task);
    journal.event(id, { type: 'run_done', runId: id, conversationId: task.conversationId, outcome: { status: 'cancelled', final: '' } });
    await journal.save(id);
    const restored = new RunJournal(dir);
    expect(await restored.list(task.conversationId)).toMatchObject([{ id, status: 'cancelled' }]);
    expect(await restored.list(randomUUID())).toEqual([]);
    await writeFile(path.join(dir, task.conversationId, `${randomUUID()}.json`), '{broken');
    expect(await restored.list(task.conversationId)).toHaveLength(1);
    await restored.removeConversation(task.conversationId);
    expect(await restored.list(task.conversationId)).toEqual([]);
    await expect(stat(path.join(dir, task.conversationId))).rejects.toThrow();
    await expect(restored.removeConversation('../escape')).rejects.toThrow();
  });
});
