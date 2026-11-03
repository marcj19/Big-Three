import { describe, expect, it } from 'vitest';
import type { FlowStep, StartRun } from '../src/shared/api.js';
import { makeApp, stub } from './helpers.js';

const flow = (conversationId: string, steps: FlowStep[], over: Partial<StartRun> = {}, fallback = false): StartRun => ({
  conversationId,
  prompt: 'Do the thing',
  spec: { kind: 'flow', steps, fallback },
  connections: [],
  peerTools: false,
  ...over,
});

describe('flows in the app', () => {
  it('runs steps with their own model, effort and access, and reports each step', async () => {
    const claude = stub('claude', '1. plan');
    const codex = stub('codex', 'Did it');
    const gemini = stub('gemini', 'ok\nVERDICT: APPROVE');
    const asked: unknown[] = [];
    const { app, workdir, done, events } = await makeApp({ adapters: { claude, codex, gemini }, confirmAccess: async (r) => (asked.push(r), true) });
    const conv = await app.createConversation({ cwd: workdir });
    await app.startRun(
      flow(conv.id, [
        { kind: 'plan', provider: 'claude', model: 'claude-opus-5-5', effort: 'high' },
        { kind: 'execute', provider: 'codex', model: 'gpt-5.1-codex', access: 'edit' },
        { kind: 'review', provider: 'gemini', model: 'gemini-4-argon-high' },
      ]),
    );
    const end = await done(conv.id);

    expect(end.outcome).toMatchObject({ status: 'ok', verdict: 'approve' });
    expect(claude.requests[0]).toMatchObject({ model: 'claude-opus-5-5', effort: 'high', access: 'read-only' });
    expect(codex.requests[0]).toMatchObject({ model: 'gpt-5.1-codex', access: 'edit' });
    expect(gemini.requests[0]).toMatchObject({ model: 'gemini-4-argon-high', access: 'read-only' });
    expect(asked).toMatchObject([{ access: 'edit', cwd: workdir }]);

    const steps = events.filter((e) => e.type === 'step').map((e) => (e.type === 'step' ? `${e.step.index}:${e.step.status}` : ''));
    expect(steps).toEqual(['0:running', '0:done', '1:running', '1:done', '2:running', '2:done']);
    const { messages } = await app.getConversation(conv.id);
    expect(messages.filter((m) => m.author === 'system').map((m) => m.text)).toEqual([
      'Etapa 1 de 3 · Plano · Claude · claude-opus-5-5',
      'Etapa 2 de 3 · Execução · Codex · gpt-5.1-codex',
      'Etapa 3 de 3 · Revisão · Gemini · gemini-4-argon-high',
    ]);
  });

  it('asks for confirmation when any step may change files, and starts nothing without it', async () => {
    const claude = stub('claude', 'x');
    const { app, workdir } = await makeApp({ adapters: { claude } });
    const conv = await app.createConversation({ cwd: workdir });
    await expect(app.startRun(flow(conv.id, [{ kind: 'execute', provider: 'claude', access: 'full' }]))).rejects.toThrow(/not confirmed/);
    expect(claude.requests).toHaveLength(0);
  });

  it('does not ask when every step only reads', async () => {
    const claude = stub('claude', 'x');
    let asks = 0;
    const { app, workdir, done } = await makeApp({ adapters: { claude }, confirmAccess: async () => (asks++, true) });
    const conv = await app.createConversation({ cwd: workdir });
    await app.startRun(flow(conv.id, [{ kind: 'execute', provider: 'claude', access: 'read-only' }]));
    await done(conv.id);
    expect(asks).toBe(0);
  });

  it('turns a flow that cannot work into a clear message before anything runs', async () => {
    const claude = stub('claude', 'x');
    const { app, workdir } = await makeApp({ adapters: { claude, gemini: stub('gemini', 'y') } });
    const conv = await app.createConversation({ cwd: workdir });
    await expect(app.startRun(flow(conv.id, [{ kind: 'execute', provider: 'claude' }]))).rejects.toThrow(/ler, editar ou acesso total/);
    await expect(app.startRun(flow(conv.id, [{ kind: 'review', provider: 'gemini' }]))).rejects.toThrow(/nada antes/);
    await expect(app.startRun(flow(conv.id, [{ kind: 'answer', provider: 'claude' }, { kind: 'review', provider: 'claude' }]))).rejects.toThrow(/outro modelo/);
    expect(claude.requests).toHaveLength(0);
  });

  it('refuses model and effort names that could be read as command-line options', async () => {
    const claude = stub('claude', 'x');
    const { app, workdir } = await makeApp({ adapters: { claude } });
    const conv = await app.createConversation({ cwd: workdir });
    for (const model of ['--dangerously-skip-permissions', '-p', 'a b', '$(id)']) {
      await expect(app.startRun(flow(conv.id, [{ kind: 'answer', provider: 'claude', model }])), model).rejects.toThrow();
    }
    await expect(app.startRun(flow(conv.id, [{ kind: 'answer', provider: 'claude', effort: '--x' }]))).rejects.toThrow();
    expect(claude.requests).toHaveLength(0);
  });

  it('lets another model stand in on a limit, but never for a step that changes files', async () => {
    const limit = [{ type: 'error' as const, message: 'You have hit your usage limit' }, { type: 'done' as const, status: 'error' as const }];
    const claude = stub('claude', () => limit);
    const gemini = stub('gemini', 'Gemini answered');
    const codex = stub('codex', () => limit);
    const { app, workdir, done } = await makeApp({ adapters: { claude, gemini, codex }, confirmAccess: async () => true });

    const c1 = await app.createConversation({ cwd: workdir });
    await app.startRun(flow(c1.id, [{ kind: 'answer', provider: 'claude' }], {}, true));
    expect((await done(c1.id)).outcome).toMatchObject({ status: 'ok', final: 'Gemini answered' });

    const before = gemini.requests.length;
    const c2 = await app.createConversation({ cwd: workdir });
    await app.startRun(flow(c2.id, [{ kind: 'execute', provider: 'codex', access: 'edit' }], {}, true));
    expect((await done(c2.id)).outcome.status).toBe('error');
    expect(gemini.requests.length).toBe(before); // Gemini was not handed the write step
  });

  it('lists the models of a provider, and falls back to the default if listing fails', async () => {
    const claude = stub('claude', 'x');
    claude.listModels = async () => [{ id: '', label: 'Padrão da conta' }, { id: 'opus', label: 'Opus' }];
    const broken = stub('gemini', 'y');
    broken.listModels = async () => {
      throw new Error('agy exploded');
    };
    const { app } = await makeApp({ adapters: { claude, gemini: broken } });
    expect((await app.listModels('claude')).map((m) => m.id)).toEqual(['', 'opus']);
    expect(await app.listModels('gemini')).toEqual([{ id: '', label: 'Padrão da conta' }]);
    expect(await app.listModels('codex')).toEqual([]);
    await expect(app.listModels('mallory' as 'claude')).rejects.toThrow();
  });

  it('reports which efforts each model takes', async () => {
    const claude = stub('claude', 'x');
    (claude as { efforts: readonly string[] }).efforts = ['low', 'high'];
    const { app } = await makeApp({ adapters: { claude } });
    expect((await app.providersStatus())[0]).toMatchObject({ id: 'claude', efforts: ['low', 'high'] });
  });
});
