import { describe, expect, it } from 'vitest';
import { Room, runFlow, validateFlow, type FlowStep, type StepEvent } from '../src/index.js';
import type { ProviderId } from '@aio/core';
import { fail, reply, stub, type StubAdapter } from './helpers.js';

const run = async (adapters: Partial<Record<ProviderId, StubAdapter>>, steps: FlowStep[], extra: { signal?: AbortSignal } = {}) => {
  const room = new Room({ adapters, cwd: '/w' });
  const events: StepEvent[] = [];
  const result = await runFlow(room, { task: 'The task', steps, onStep: (e) => events.push(e), ...extra });
  return { room, events, result };
};

describe('validateFlow', () => {
  const answer: FlowStep = { kind: 'answer', provider: 'claude' };

  it('accepts sensible flows', () => {
    expect(validateFlow([answer])).toBeUndefined();
    expect(validateFlow([{ kind: 'plan', provider: 'claude' }, { kind: 'execute', provider: 'codex', access: 'read-only' }, { kind: 'review', provider: 'gemini' }])).toBeUndefined();
    expect(validateFlow([answer, { kind: 'review', provider: 'gemini' }, { kind: 'revise', provider: 'claude' }])).toBeUndefined();
  });

  it('refuses an empty or oversized flow', () => {
    expect(validateFlow([])).toMatch(/pelo menos uma/);
    expect(validateFlow(Array.from({ length: 9 }, () => answer))).toMatch(/no máximo/);
  });

  it('makes the person decide what an executing model may do', () => {
    expect(validateFlow([{ kind: 'execute', provider: 'claude' }])).toMatch(/Etapa 1.*ler, editar ou acesso total/);
  });

  it('a review or correction needs earlier work, and a model cannot review its own', () => {
    expect(validateFlow([{ kind: 'review', provider: 'gemini' }])).toMatch(/nada antes/);
    expect(validateFlow([{ kind: 'plan', provider: 'claude' }, { kind: 'review', provider: 'gemini' }])).toMatch(/nada antes/);
    expect(validateFlow([answer, { kind: 'review', provider: 'claude' }])).toMatch(/outro modelo/);
  });

  it('a debate needs two different models', () => {
    expect(validateFlow([{ kind: 'debate', provider: 'claude', members: [{ provider: 'claude' }, { provider: 'claude' }] }])).toMatch(/dois modelos diferentes/);
    expect(validateFlow([{ kind: 'debate', provider: 'claude' }])).toMatch(/dois modelos diferentes/);
  });
});

describe('runFlow', () => {
  it('runs one answer step with the chosen model and effort, and marks the step in the transcript', async () => {
    const claude = stub('claude', 'The answer');
    const { room, events, result } = await run({ claude }, [{ kind: 'answer', provider: 'claude', model: 'claude-opus-5-5', effort: 'high' }]);

    expect(result).toMatchObject({ status: 'ok', final: 'The answer' });
    expect(claude.requests[0]).toMatchObject({ model: 'claude-opus-5-5', effort: 'high', access: 'read-only' });
    expect(events.map((e) => e.status)).toEqual(['running', 'done']);
    expect((await room.messages()).map((m) => [m.author, m.text])).toEqual([
      ['user', 'The task'],
      ['system', 'Etapa 1 de 1 · Resposta · Claude · claude-opus-5-5'],
      ['claude', 'The answer'],
    ]);
  });

  it('plan, execute, review: each step uses its own model and the access it was given', async () => {
    const claude = stub('claude', '1. Edit a.ts');
    const codex = stub('codex', 'Edited a.ts');
    const gemini = stub('gemini', 'Matches.\nVERDICT: APPROVE');
    const { result, events } = await run({ claude, codex, gemini }, [
      { kind: 'plan', provider: 'claude', model: 'opus' },
      { kind: 'execute', provider: 'codex', model: 'gpt-5.1-codex', access: 'edit' },
      { kind: 'review', provider: 'gemini', model: 'gemini-4-argon-high' },
    ]);

    expect(claude.requests[0]).toMatchObject({ model: 'opus', access: 'read-only' });
    expect(codex.requests[0]).toMatchObject({ model: 'gpt-5.1-codex', access: 'edit' });
    expect(gemini.requests[0]).toMatchObject({ model: 'gemini-4-argon-high', access: 'read-only' });
    expect(codex.requests[0]!.prompt).toContain('1. Edit a.ts');
    expect(gemini.requests[0]!.prompt).toContain('Edited a.ts');
    expect(result).toMatchObject({ status: 'ok', final: 'Edited a.ts', verdict: 'approve' });
    expect(events.filter((e) => e.status === 'done').map((e) => e.index)).toEqual([0, 1, 2]);
    expect(events.find((e) => e.index === 2 && e.status === 'done')?.note).toBe('aprovado');
  });

  it('never runs a flow that cannot work', async () => {
    const claude = stub('claude', 'x');
    const { result } = await run({ claude }, [{ kind: 'execute', provider: 'claude' }]);
    expect(result).toMatchObject({ status: 'error', error: expect.stringContaining('ler, editar ou acesso total') });
    expect(claude.requests).toHaveLength(0);
  });

  it('runs the correction only when the review asked for changes', async () => {
    const flow: FlowStep[] = [{ kind: 'answer', provider: 'claude' }, { kind: 'review', provider: 'gemini' }, { kind: 'revise', provider: 'claude' }];

    const approved = await run({ claude: stub('claude', 'v1'), gemini: stub('gemini', 'Fine.\nVERDICT: APPROVE') }, flow);
    expect(approved.events.find((e) => e.kind === 'revise')).toMatchObject({ status: 'skipped' });
    expect(approved.result).toMatchObject({ status: 'ok', final: 'v1', verdict: 'approve' });

    const claude = stub('claude', (_r, call) => reply(call === 1 ? 'v1' : 'v2'));
    const changes = await run({ claude, gemini: stub('gemini', 'Bug.\nVERDICT: CHANGES') }, flow);
    expect(changes.result).toMatchObject({ status: 'ok', final: 'v2', verdict: 'changes' });
    expect(claude.requests[1]!.prompt).toContain('Bug.');
    expect(changes.events.filter((e) => e.kind === 'revise').map((e) => e.status)).toEqual(['running', 'done']);
  });

  it('a review falls back to another model without handing it the first one\'s model name', async () => {
    const gemini = stub('gemini', () => fail('usage limit reached'));
    const codex = stub('codex', 'ok\nVERDICT: APPROVE');
    const { result } = await run({ claude: stub('claude', 'v1'), gemini, codex }, [
      { kind: 'answer', provider: 'claude' },
      { kind: 'review', provider: 'gemini', model: 'gemini-4-argon-high', fallback: ['codex'] },
    ]);
    expect(result.status).toBe('ok');
    expect(gemini.requests[0]!.model).toBe('gemini-4-argon-high');
    expect(codex.requests[0]!.model).toBeUndefined();
  });

  it('when the reviewer\'s only choice is the author, it explains instead of reviewing its own work', async () => {
    // The author switched at run time (its own fallback), so the static check could not know.
    const claude = stub('claude', () => fail('usage limit reached'));
    const codex = stub('codex', 'v1');
    const { result } = await run({ claude, codex, gemini: stub('gemini', 'x') }, [
      { kind: 'answer', provider: 'claude', fallback: ['codex'] },
      { kind: 'review', provider: 'gemini', fallback: ['codex'] },
    ]);
    expect(result.status).toBe('ok');
    // codex wrote it, so the reviewer list [gemini, codex] loses codex and gemini reviews
    expect(codex.requests).toHaveLength(1);
  });

  it('a debate step uses each member\'s own model and a judge', async () => {
    const claude = stub('claude', (_r, call) => reply(call <= 2 ? 'Claude view' : 'Synthesis'));
    const gemini = stub('gemini', 'Gemini view');
    const { result } = await run({ claude, gemini }, [
      { kind: 'debate', provider: 'claude', rounds: 2, model: 'opus', members: [{ provider: 'claude', model: 'sonnet' }, { provider: 'gemini', model: 'gemini-4-argon-low' }] },
    ]);
    expect(result).toMatchObject({ status: 'ok', final: 'Synthesis' });
    expect(claude.requests[0]!.model).toBe('sonnet');
    expect(gemini.requests[0]!.model).toBe('gemini-4-argon-low');
    expect(claude.requests[2]!.model).toBe('opus'); // the closing synthesis uses the step's own model
    expect(claude.requests[0]!.prompt).not.toContain('Gemini view'); // first round is independent
    expect(claude.requests[1]!.prompt).toContain('Gemini view');
  });

  it('a debate carries on when one member cannot answer, and a new judge drops the old judge\'s model', async () => {
    const claude = stub('claude', () => fail('quota exhausted'));
    const gemini = stub('gemini', 'Only view');
    const { result } = await run({ claude, gemini }, [
      { kind: 'debate', provider: 'claude', model: 'opus', members: [{ provider: 'claude' }, { provider: 'gemini' }] },
    ]);
    expect(result).toMatchObject({ status: 'ok' });
    expect(gemini.requests.at(-1)!.model).toBeUndefined();
  });

  it('stops at the first step that fails and says which', async () => {
    const codex = stub('codex', 'x');
    const { result, events } = await run({ claude: stub('claude', () => fail('boom')), codex }, [
      { kind: 'plan', provider: 'claude' },
      { kind: 'execute', provider: 'codex', access: 'edit' },
    ]);
    expect(result).toMatchObject({ status: 'error', error: 'boom' });
    expect(codex.requests).toHaveLength(0);
    expect(events.at(-1)).toMatchObject({ index: 0, status: 'error', error: 'boom' });
  });

  it('reports cancellation', async () => {
    const ac = new AbortController();
    ac.abort();
    const { result } = await run({ claude: stub('claude', 'x') }, [{ kind: 'answer', provider: 'claude' }], { signal: ac.signal });
    expect(result.status).toBe('cancelled');
  });
});

describe('model choice and fallback in a turn', () => {
  it('the chosen model goes only to the first provider tried', async () => {
    const claude = stub('claude', () => fail('usage limit reached'));
    const codex = stub('codex', 'ok');
    const room = new Room({ adapters: { claude, codex }, cwd: '/w' });
    await room.turn(['claude', 'codex'], 'go', { model: 'opus', effort: 'high' });
    expect(claude.requests[0]).toMatchObject({ model: 'opus', effort: 'high' });
    expect(codex.requests[0]!.model).toBeUndefined();
    expect(codex.requests[0]!.effort).toBeUndefined();
  });
});
