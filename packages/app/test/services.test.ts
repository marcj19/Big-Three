import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { ConnectionService } from '../src/services/connections.js';
import { ConversationStore } from '../src/services/conversations.js';
import type { StartRun } from '../src/shared/api.js';
import { makeApp, memoryVault, stub, tmp } from './helpers.js';

describe('ConversationStore', () => {
  it('creates, lists newest first, renames and removes', async () => {
    const store = new ConversationStore(await tmp());
    const a = await store.create({ cwd: '/a' });
    await new Promise((r) => setTimeout(r, 5));
    const b = await store.create({ cwd: '/b', title: 'Second' });
    expect((await store.list()).map((c) => c.id)).toEqual([b.id, a.id]);

    await store.rename(a.id, '  Renamed  ');
    expect((await store.get(a.id)).title).toBe('Renamed');
    await expect(store.rename(a.id, '   ')).rejects.toThrow(/empty/);

    await store.remove(a.id);
    expect((await store.list()).map((c) => c.id)).toEqual([b.id]);
  });

  it('names an untitled conversation after its first prompt, once', async () => {
    const store = new ConversationStore(await tmp());
    const c = await store.create({ cwd: '/a' });
    await store.touch(c.id, 'How do I   avoid a deadlock in this code?');
    await store.touch(c.id, 'A different later prompt');
    expect((await store.get(c.id)).title).toBe('How do I avoid a deadlock in this code?');
  });

  it('keeps every conversation when many are created at once', async () => {
    const store = new ConversationStore(await tmp());
    await Promise.all(Array.from({ length: 15 }, (_, i) => store.create({ cwd: `/c${i}` })));
    expect(await store.list()).toHaveLength(15);
  });

  it('refuses ids that could escape the folder', async () => {
    const dir = await tmp();
    const store = new ConversationStore(dir);
    for (const id of ['../../etc/passwd', '..\\..\\x', 'abc', '']) {
      await expect(store.get(id), id).rejects.toThrow(/Invalid/);
      await expect(store.remove(id), id).rejects.toThrow(/Invalid/);
      expect(() => store.transcript(id), id).toThrow(/Invalid/);
    }
  });
});

describe('ConnectionService', () => {
  const input = { name: 'crm', engine: 'postgres' as const, host: 'h', database: 'd', user: 'u' };

  it('saves a profile without a password, and reports whether the vault has one', async () => {
    const vault = memoryVault();
    const svc = new ConnectionService(await tmp(), vault.store);
    await svc.save(input);
    expect(await svc.list()).toEqual([{ ...input, port: 5432, ssl: undefined, hasPassword: false }]);

    await svc.setPassword('crm', 's3cret');
    expect((await svc.list())[0]!.hasPassword).toBe(true);
    expect(JSON.stringify(await svc.list())).not.toContain('s3cret');
    expect([...vault.data.values()]).toEqual(['s3cret']);
  });

  it('will not store a password for a connection that was never saved', async () => {
    const svc = new ConnectionService(await tmp(), memoryVault().store);
    await expect(svc.setPassword('ghost', 'x')).rejects.toThrow(/Save the connection/);
    await expect(svc.setPassword('../x', 'x')).rejects.toThrow(/Invalid/);
  });

  it('removes the password together with the connection', async () => {
    const vault = memoryVault();
    const svc = new ConnectionService(await tmp(), vault.store);
    await svc.save(input);
    await svc.setPassword('crm', 'pw');
    await svc.remove('crm');
    expect(await svc.list()).toEqual([]);
    expect(vault.data.size).toBe(0);
  });

  it('reports a bad profile as one readable line', async () => {
    const svc = new ConnectionService(await tmp(), memoryVault().store);
    await expect(svc.save({ ...input, name: 'has space' })).rejects.toThrow(/^name: /);
    await expect(svc.save({ ...input, host: '' })).rejects.toThrow(/^host: /);
  });

  it('reports a failed test without leaking details, and an unknown connection plainly', async () => {
    const svc = new ConnectionService(await tmp(), memoryVault().store);
    expect(await svc.test('nope')).toEqual({ ok: false, error: 'Unknown connection' });
    await svc.save(input);
    const noPassword = await svc.test('crm');
    expect(noPassword.ok).toBe(false);
    expect(noPassword.error).toMatch(/No credentials/);
  });
});

describe('AppService', () => {
  const chat = (conversationId: string, over: Partial<StartRun> = {}): StartRun => ({
    conversationId,
    prompt: 'Hello',
    spec: { kind: 'chat', providers: ['claude'], access: 'read-only' },
    connections: [],
    peerTools: false,
    ...over,
  });

  it('reports the state of every configured model', async () => {
    const { app } = await makeApp({ adapters: { claude: stub('claude', 'x'), gemini: stub('gemini', 'y', { mcp: false }) } });
    expect(await app.providersStatus()).toMatchObject([
      { id: 'claude', available: true, signedIn: true, supportsMcp: true, canLogin: true },
      { id: 'gemini', available: true, signedIn: true, supportsMcp: false },
    ]);
  });

  it('runs a chat turn, streams events, stores the answer and names the conversation', async () => {
    const claude = stub('claude', 'An answer');
    const { app, events, workdir, done } = await makeApp({ adapters: { claude } });
    const conv = await app.createConversation({ cwd: workdir });
    await app.startRun(chat(conv.id, { prompt: 'Explain mutexes' }));
    const end = await done(conv.id);

    expect(end.outcome).toMatchObject({ status: 'ok', final: 'An answer' });
    const { meta, messages } = await app.getConversation(conv.id);
    expect(messages.map((m) => [m.author, m.text])).toEqual([['user', 'Explain mutexes'], ['claude', 'An answer']]);
    expect(meta.title).toBe('Explain mutexes');
    expect(events.filter((e) => e.type === 'room').map((e) => (e as { event: { type: string } }).event.type)).toEqual(['turn_start', 'turn_end']);
    expect(claude.requests[0]!.cwd).toBe(workdir);
    expect(claude.requests[0]!.access).toBe('read-only');
    expect((await app.usage()).claude).toMatchObject({ turns: 1, inputTokens: 3, outputTokens: 2 });
  });

  it('runs every pattern', async () => {
    const adapters = { claude: stub('claude', 'plan or answer\nVERDICT: APPROVE'), gemini: stub('gemini', 'review\nVERDICT: APPROVE'), codex: stub('codex', 'did it') };
    const { app, workdir, done } = await makeApp({ adapters });
    // One conversation per pattern, so each run_done event is unambiguous.
    const outcome = async (spec: StartRun['spec']) => {
      const conv = await app.createConversation({ cwd: workdir });
      await app.startRun(chat(conv.id, { spec }));
      return (await done(conv.id)).outcome;
    };
    expect(await outcome({ kind: 'review', author: 'claude', reviewer: 'gemini' })).toMatchObject({ status: 'ok', verdict: 'approve' });
    expect(await outcome({ kind: 'debate', participants: ['claude', 'gemini'], rounds: 1 })).toMatchObject({ status: 'ok' });
    expect(await outcome({ kind: 'plan', planner: 'claude', executor: 'codex', executorAccess: 'read-only', reviewer: 'gemini' })).toMatchObject({
      status: 'ok',
      verdict: 'approve',
    });
  });

  it('rejects malformed requests before anything runs', async () => {
    const claude = stub('claude', 'x');
    const { app, workdir } = await makeApp({ adapters: { claude } });
    const conv = await app.createConversation({ cwd: workdir });
    const bad = async (patch: unknown) => app.startRun({ ...chat(conv.id), ...(patch as object) }).then(() => 'started', (e: Error) => e.message);

    expect(await bad({ prompt: '   ' })).toMatch(/Write something/);
    expect(await bad({ spec: { kind: 'chat', providers: ['mallory'], access: 'read-only' } })).not.toBe('started');
    expect(await bad({ spec: { kind: 'chat', providers: ['claude'], access: 'root' } })).not.toBe('started');
    expect(await bad({ spec: { kind: 'chat', providers: ['gemini'], access: 'read-only' } })).toMatch(/Not available: gemini/);
    expect(await bad({ spec: { kind: 'debate', participants: ['claude'] } })).not.toBe('started');
    expect(await bad({ connections: ['nope'] })).toMatch(/Unknown connection/);
    expect(await bad({ conversationId: '../../x' })).toMatch(/Invalid/);
    expect(claude.requests).toHaveLength(0);
  });

  describe('write access', () => {
    it('reuses a conversation grant and requires approval again after escalation or revocation', async () => {
      const asked: string[] = [];
      const claude = stub('claude', 'OK');
      const { app, workdir, events } = await makeApp({ adapters: { claude }, confirmAccess: async ({ access }) => (asked.push(access), true) });
      const conv = await app.createConversation({ cwd: workdir });
      const other = await app.createConversation({ cwd: workdir });
      expect(await app.setConversationAccess(conv.id, 'edit')).toBe('edit');
      for (let i = 1; i <= 2; i++) {
        const { runId } = await app.startRun(chat(conv.id, { spec: { kind: 'chat', providers: ['claude'], access: 'edit' } }));
        await vi.waitFor(() => expect(events.some((e) => e.type === 'run_done' && e.runId === runId)).toBe(true));
      }
      expect(asked).toEqual(['edit']);
      expect(claude.requests.map((r) => r.access)).toEqual(['edit', 'edit']);
      expect((await app.getConversation(other.id)).access).toBe('read-only');
      expect((await app.getConversation(conv.id)).access).toBe('edit');
      await app.setConversationAccess(conv.id, 'full');
      await app.setConversationAccess(conv.id, 'edit');
      await app.setConversationAccess(conv.id, 'read-only');
      expect((await app.getConversation(conv.id)).access).toBe('read-only');
      await app.setConversationAccess(conv.id, 'edit');
      expect(asked).toEqual(['edit', 'full', 'edit']);
    });
    const planWith = (executorAccess: 'edit' | 'full'): StartRun['spec'] => ({ kind: 'plan', planner: 'claude', executor: 'claude', executorAccess });

    it('is refused when nothing confirms it, and nothing starts', async () => {
      const claude = stub('claude', 'x');
      const { app, workdir } = await makeApp({ adapters: { claude } });
      const conv = await app.createConversation({ cwd: workdir });
      await expect(app.startRun(chat(conv.id, { spec: planWith('edit') }))).rejects.toThrow(/not confirmed/);
      await expect(app.startRun(chat(conv.id, { spec: { kind: 'chat', providers: ['claude'], access: 'full' } }))).rejects.toThrow(/not confirmed/);
      expect(claude.requests).toHaveLength(0);
      expect((await app.getConversation(conv.id)).messages).toEqual([]);
    });

    it('asks the person, with the level and the folder, and respects a no', async () => {
      const claude = stub('claude', 'x');
      const asked: unknown[] = [];
      const { app, workdir } = await makeApp({ adapters: { claude }, confirmAccess: async (r) => (asked.push(r), false) });
      const conv = await app.createConversation({ cwd: workdir });
      await expect(app.startRun(chat(conv.id, { spec: planWith('full') }))).rejects.toThrow(/not confirmed/);
      expect(asked).toMatchObject([{ access: 'full', cwd: workdir }]);
      expect(claude.requests).toHaveLength(0);
    });

    it('runs with the confirmed access, and never asks for read-only', async () => {
      const claude = stub('claude', 'x');
      let asks = 0;
      const { app, workdir, done } = await makeApp({ adapters: { claude }, confirmAccess: async () => (asks++, true) });
      const conv = await app.createConversation({ cwd: workdir });
      await app.startRun(chat(conv.id, { spec: planWith('edit') }));
      await done(conv.id);
      expect(asks).toBe(1);
      expect(claude.requests.map((r) => r.access)).toEqual(['read-only', 'edit']);

      const c2 = await app.createConversation({ cwd: workdir });
      await app.startRun(chat(c2.id));
      await done(c2.id);
      expect(asks).toBe(1);
    });
  });

  it('hands the database to models that can take it, with names and a folder but no password', async () => {
    const claude = stub('claude', 'x');
    const gemini = stub('gemini', 'y', { mcp: false });
    const { app, workdir, done, configDir } = await makeApp({ adapters: { claude, gemini } });
    await app.saveConnection({ name: 'crm', engine: 'postgres', host: 'h', database: 'd', user: 'u' });
    await app.saveConnection({ name: 'erp', engine: 'mysql', host: 'h', database: 'd', user: 'u' });
    await app.setPassword('crm', 'TOP-SECRET-PW');
    const conv = await app.createConversation({ cwd: workdir });
    await app.startRun(chat(conv.id, { spec: { kind: 'debate', participants: ['claude', 'gemini'], rounds: 1 }, connections: ['crm'] }));
    await done(conv.id);

    const spec = claude.requests[0]!.mcpServers![0]!;
    expect(spec).toMatchObject({ name: 'db', args: ['/x/server.js'], env: { AIO_CONFIG_DIR: configDir, AIO_CONNECTIONS: 'crm' } });
    expect(JSON.stringify(claude.requests)).not.toContain('TOP-SECRET-PW');
    expect(gemini.requests[0]!.mcpServers).toBeUndefined();
  });

  it('gives the room tools only when asked', async () => {
    const claude = stub('claude', 'x');
    const gemini = stub('gemini', 'y', { mcp: false });
    const { app, workdir, done } = await makeApp({ adapters: { claude, gemini } });
    const conv = await app.createConversation({ cwd: workdir });
    await app.startRun(chat(conv.id, { peerTools: true }));
    await done(conv.id);
    expect(claude.requests[0]!.mcpServers?.[0]).toMatchObject({ name: 'room', args: ['/x/peer-main.js'] });

    const c2 = await app.createConversation({ cwd: workdir });
    await app.startRun(chat(c2.id));
    await done(c2.id);
    expect(claude.requests[1]!.mcpServers).toBeUndefined();
  });

  it('allows one run per conversation, and cancelling ends it as cancelled', async () => {
    const claude = stub('claude', 'slow', { delayMs: 5_000 });
    const { app, workdir, done, events } = await makeApp({ adapters: { claude } });
    const conv = await app.createConversation({ cwd: workdir });
    const { runId } = await app.startRun(chat(conv.id));
    await expect(app.startRun(chat(conv.id))).rejects.toThrow(/already running/);
    await expect(app.deleteConversation(conv.id)).rejects.toThrow(/Cancel/);

    await app.cancelRun(runId);
    expect((await done(conv.id)).outcome.status).toBe('cancelled');
    expect(events.at(-1)).toMatchObject({ type: 'run_done' });
    // and the conversation is free again
    await expect(app.deleteConversation(conv.id)).resolves.toBeUndefined();
  });

  it('shows a failed run as an error outcome', async () => {
    const claude = stub('claude', () => [{ type: 'error', message: 'boom' }, { type: 'done', status: 'error' }]);
    const { app, workdir, done } = await makeApp({ adapters: { claude } });
    const conv = await app.createConversation({ cwd: workdir });
    await app.startRun(chat(conv.id));
    expect((await done(conv.id)).outcome).toMatchObject({ status: 'error', error: 'boom' });
  });

  it('will not start a conversation in a folder that does not exist', async () => {
    const { app, workdir } = await makeApp({ adapters: { claude: stub('claude', 'x') } });
    await expect(app.createConversation({ cwd: path.join(workdir, 'missing') })).rejects.toThrow(/does not exist/);
  });

  it('streams sign-in progress as events', async () => {
    const claude = stub('claude', 'x');
    const { app, events } = await makeApp({ adapters: { claude } });
    await app.loginProvider('claude');
    await new Promise((r) => setTimeout(r, 50));
    expect(events).toEqual([
      { type: 'login', provider: 'claude', event: { type: 'output', line: 'open browser' } },
      { type: 'login', provider: 'claude', event: { type: 'done', ok: true } },
    ]);
    await expect(app.loginProvider('mallory' as 'claude')).rejects.toThrow();
  });
});
