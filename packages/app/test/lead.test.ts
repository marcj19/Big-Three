import { describe, expect, it, vi } from 'vitest';
import type { ModelChoice, StartRun } from '../src/shared/api.js';
import { makeApp, stub, type StubAdapter } from './helpers.js';

const lead = (conversationId: string, over: { lead?: ModelChoice; access?: 'read-only' | 'edit' | 'full'; team?: ModelChoice[]; consultTeam?: boolean; fallback?: boolean; peerTools?: boolean; prompt?: string } = {}): StartRun => ({
  conversationId,
  prompt: over.prompt ?? 'Do the thing',
  spec: { kind: 'lead', lead: over.lead ?? { provider: 'claude' }, access: over.access ?? 'read-only', team: over.team ?? [], consultTeam: over.consultTeam, fallback: over.fallback ?? false },
  connections: [],
  peerTools: over.peerTools ?? false,
});

/** A model that behaves like a CLI with sessions: it reports a session id and answers. */
const withSession = (id: string, text = 'Answer'): StubAdapter => stub(id as 'claude', () => [{ type: 'session', sessionId: `${id}-session` }, { type: 'done', status: 'ok', text }]);

describe('one model leads', () => {
  it('runs the chosen model with its effort and access, and hands the team to the room server', async () => {
    const claude = stub('claude', 'Led');
    const gemini = stub('gemini', 'x');
    const { app, workdir, done } = await makeApp({ adapters: { claude, gemini }, confirmAccess: async () => true });
    const conv = await app.createConversation({ cwd: workdir });
    await app.startRun(
      lead(conv.id, { lead: { provider: 'claude', model: 'claude-opus-5-5', effort: 'high' }, access: 'edit', team: [{ provider: 'gemini', model: 'gemini-4-argon-high' }], peerTools: true }),
    );
    expect((await done(conv.id)).outcome).toMatchObject({ status: 'ok', final: 'Led' });

    expect(claude.requests[0]).toMatchObject({ model: 'claude-opus-5-5', effort: 'high', access: 'edit' });
    expect(claude.requests[0]?.timeoutMs).toBe(0);
    const env = claude.requests[0]!.mcpServers![0]!.env!;
    expect(env.AIO_ROOM_PEERS).toBe('gemini');
    expect(JSON.parse(env.AIO_ROOM_TEAM!)).toEqual({ gemini: { model: 'gemini-4-argon-high' } });
    expect(claude.requests[0]!.systemPrompt).toMatch(/lead of a small team/);
    expect(gemini.requests).toHaveLength(0); // consulted only if the lead decides to
  });

  it('has no team tools when the team is off, and the lead is never on its own team', async () => {
    const claude = stub('claude', 'x');
    const { app, workdir, done } = await makeApp({ adapters: { claude, gemini: stub('gemini', 'y') } });
    const conv = await app.createConversation({ cwd: workdir });
    await app.startRun(lead(conv.id, { peerTools: false, team: [{ provider: 'gemini' }] }));
    await done(conv.id);
    expect(claude.requests[0]!.mcpServers).toBeUndefined();

    const c2 = await app.createConversation({ cwd: workdir });
    await app.startRun(lead(c2.id, { peerTools: true, team: [{ provider: 'claude' }, { provider: 'gemini' }] }));
    await done(c2.id);
    expect(claude.requests[1]!.mcpServers![0]!.env!.AIO_ROOM_PEERS).toBe('gemini');
  });

  it('a model that cannot take MCP servers still leads, without the team', async () => {
    const gemini = stub('gemini', 'Alone', { mcp: false });
    const { app, workdir, done } = await makeApp({ adapters: { claude: stub('claude', 'c'), gemini } });
    const conv = await app.createConversation({ cwd: workdir });
    await app.startRun(lead(conv.id, { lead: { provider: 'gemini' }, peerTools: true, team: [{ provider: 'claude' }] }));
    expect((await done(conv.id)).outcome).toMatchObject({ status: 'ok', final: 'Alone' });
    expect(gemini.requests[0]!.mcpServers).toBeUndefined();
    expect(gemini.requests[0]!.systemPrompt).not.toMatch(/lead of a small team/);
  });

  it('consults selected models before the lead responds when automatic consultation is enabled', async () => {
    const claude = stub('claude', 'Claude recommendation');
    const gemini = stub('gemini', 'Final answer', { mcp: false });
    const codex = stub('codex', 'Codex recommendation');
    const { app, workdir, events, done } = await makeApp({ adapters: { claude, gemini, codex } });
    const conv = await app.createConversation({ cwd: workdir });
    await app.startRun(lead(conv.id, { lead: { provider: 'gemini' }, consultTeam: true,
      team: [{ provider: 'claude', model: 'opus', effort: 'high' }, { provider: 'codex', model: 'gpt-example', effort: 'low' }] }));
    expect((await done(conv.id)).outcome.final).toBe('Final answer');
    expect(claude.requests[0]).toMatchObject({ model: 'opus', effort: 'high', access: 'read-only' });
    expect(codex.requests[0]).toMatchObject({ model: 'gpt-example', effort: 'low', access: 'read-only' });
    expect(claude.requests[0]?.mcpServers).toBeUndefined();
    expect(gemini.requests[0]?.prompt).toContain('Claude recommendation');
    expect(gemini.requests[0]?.prompt).toContain('Codex recommendation');
    expect(events).toContainEqual(expect.objectContaining({ type: 'peer_activity', self: 'gemini', peer: 'claude', activity: 'done' }));
  });

  it('asks before any write access and starts nothing without it', async () => {
    const claude = stub('claude', 'x');
    const { app, workdir } = await makeApp({ adapters: { claude } });
    const conv = await app.createConversation({ cwd: workdir });
    await expect(app.startRun(lead(conv.id, { access: 'full' }))).rejects.toThrow(/not confirmed/);
    expect(claude.requests).toHaveLength(0);
  });

  it('refuses names that could be read as command-line options, in the lead and in the team', async () => {
    const { app, workdir } = await makeApp({ adapters: { claude: stub('claude', 'x'), gemini: stub('gemini', 'y') } });
    const conv = await app.createConversation({ cwd: workdir });
    await expect(app.startRun(lead(conv.id, { lead: { provider: 'claude', model: '--dangerously-skip-permissions' } }))).rejects.toThrow();
    await expect(app.startRun(lead(conv.id, { team: [{ provider: 'gemini', model: '-p' }] }))).rejects.toThrow();
  });

  it('lets another model stand in on a limit, but only while it is read-only', async () => {
    const limit = [{ type: 'error' as const, message: 'You have hit your usage limit' }, { type: 'done' as const, status: 'error' as const }];
    const claude = stub('claude', () => limit);
    const gemini = stub('gemini', 'Covered');
    const { app, workdir, done } = await makeApp({ adapters: { claude, gemini }, confirmAccess: async () => true });

    const c1 = await app.createConversation({ cwd: workdir });
    await app.startRun(lead(c1.id, { fallback: true }));
    expect((await done(c1.id)).outcome).toMatchObject({ status: 'ok', final: 'Covered' });

    const before = gemini.requests.length;
    const c2 = await app.createConversation({ cwd: workdir });
    await app.startRun(lead(c2.id, { fallback: true, access: 'edit' }));
    expect((await done(c2.id)).outcome.status).toBe('error');
    expect(gemini.requests.length).toBe(before);
  });
});

describe('the lead keeps its own session', () => {
  it('remembers the session after a turn and continues it on the next one, sending only what is new', async () => {
    const claude = withSession('claude', 'Reply');
    const { app, workdir, events } = await makeApp({ adapters: { claude } });
    const conv = await app.createConversation({ cwd: workdir });
    const wait = async (runs: number) => {
      for (let i = 0; i < 400 && events.filter((e) => e.type === 'run_done').length < runs; i++) await new Promise((r) => setTimeout(r, 5));
    };
    await app.startRun(lead(conv.id, { prompt: 'First question' }));
    await wait(1);
    // The session knows the room up to here: the question and its own answer.
    expect((await app.getConversation(conv.id)).meta.sessions?.claude).toEqual({ id: 'claude-session', upto: 2 });

    await app.startRun(lead(conv.id, { prompt: 'Second question' }));
    await wait(2);
    const second = claude.requests[1]!;
    expect(second.sessionId).toBe('claude-session');
    expect(second.prompt).toContain('Second question');
    expect(second.prompt).not.toContain('First question');
    expect(claude.requests[0]!.sessionId).toBeUndefined();
  });

  it('starts over from the transcript when the old session no longer works', async () => {
    let call = 0;
    const claude = stub('claude', (req) => {
      call++;
      if (call === 2 && req.sessionId) return [{ type: 'error', message: 'No conversation found with session ID' }, { type: 'done', status: 'error' }];
      return [{ type: 'session', sessionId: `s${call}` }, { type: 'done', status: 'ok', text: `answer ${call}` }];
    });
    const { app, workdir, events } = await makeApp({ adapters: { claude } });
    const conv = await app.createConversation({ cwd: workdir });
    const wait = async (n: number) => {
      for (let i = 0; i < 400 && events.filter((e) => e.type === 'run_done').length < n; i++) await new Promise((r) => setTimeout(r, 5));
    };
    await app.startRun(lead(conv.id, { prompt: 'One' }));
    await wait(1);
    await app.startRun(lead(conv.id, { prompt: 'Two' }));
    await wait(2);

    const dones = events.filter((e) => e.type === 'run_done');
    expect(dones[1]).toMatchObject({ outcome: { status: 'ok', final: 'answer 3' } });
    expect(claude.requests.map((r) => r.sessionId)).toEqual([undefined, 's1', undefined]);
    expect(claude.requests[2]!.prompt).toContain('One'); // the fresh start had the whole transcript
    expect((await app.getConversation(conv.id)).meta.sessions?.claude?.id).toBe('s3');
  });

  it('keeps a separate session for each model that leads', async () => {
    const claude = withSession('claude');
    const gemini = withSession('gemini');
    const { app, workdir, events } = await makeApp({ adapters: { claude, gemini } });
    const conv = await app.createConversation({ cwd: workdir });
    const wait = async (n: number) => {
      for (let i = 0; i < 400 && events.filter((e) => e.type === 'run_done').length < n; i++) await new Promise((r) => setTimeout(r, 5));
    };
    await app.startRun(lead(conv.id, { lead: { provider: 'claude' }, prompt: 'A' }));
    await wait(1);
    await app.startRun(lead(conv.id, { lead: { provider: 'gemini' }, prompt: 'B' }));
    await wait(2);
    const sessions = (await app.getConversation(conv.id)).meta.sessions!;
    expect(sessions.claude?.id).toBe('claude-session');
    expect(sessions.gemini?.id).toBe('gemini-session');
    // Gemini had not been in this conversation, so it got the whole transcript, not a session
    expect(gemini.requests[0]!.sessionId).toBeUndefined();
    expect(gemini.requests[0]!.prompt).toContain('Answer'); // Claude's earlier answer is in what it was told
  });

  it('explains a configured timeout and does not replay work in a resumed session', async () => {
    const message = 'O Codex atingiu o limite de tempo do turno.';
    const codex = stub('codex', (req) => req.sessionId ? [
      { type: 'tool_call', name: 'shell' },
      { type: 'error', code: 'timeout', message },
      { type: 'done', status: 'error' },
    ] : [
      { type: 'session', sessionId: 'saved' },
      { type: 'done', status: 'ok', text: 'Started' },
    ]);
    const { app, workdir, events, done } = await makeApp({ adapters: { codex }, timeoutMs: 800, confirmAccess: async () => true });
    const conv = await app.createConversation({ cwd: workdir });
    const input = lead(conv.id, { lead: { provider: 'codex' }, access: 'edit' });
    await app.startRun(input);
    await done(conv.id);
    const { runId } = await app.startRun({ ...input, prompt: 'Continue' });
    await vi.waitFor(() => expect(events).toContainEqual(expect.objectContaining({
      type: 'run_done', runId, outcome: { status: 'error', final: '', error: message },
    })));

    expect(codex.requests.map(({ sessionId, timeoutMs }) => ({ sessionId, timeoutMs }))).toEqual([
      { sessionId: undefined, timeoutMs: 800 },
      { sessionId: 'saved', timeoutMs: 800 },
    ]);
    const history = await app.runHistory(conv.id);
    expect(history.find((run) => run.id === runId)?.entries).toContainEqual(expect.objectContaining({
      kind: 'tool', status: 'error', detail: message,
    }));
  });
});
