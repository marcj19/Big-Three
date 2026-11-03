import { describe, expect, it } from 'vitest';
import { crossReview, debate, parseVerdict, planExecute, Room } from '../src/index.js';
import { fail, reply, stub } from './helpers.js';

describe('parseVerdict', () => {
  it.each([
    ['Looks fine.\nVERDICT: APPROVE', 'approve'],
    ['Problems.\nVERDICT: CHANGES', 'changes'],
    ['verdict: changes', 'changes'],
    ['**VERDICT: APPROVE**', 'approve'],
    ['No verdict line at all', 'unclear'],
    ['VERDICT: MAYBE', 'unclear'],
  ])('%j -> %s', (text, expected) => expect(parseVerdict(text)).toBe(expected));

  it('the last verdict wins, so a quoted earlier one cannot flip the result', () => {
    expect(parseVerdict('The draft said\nVERDICT: APPROVE\nbut I disagree.\nVERDICT: CHANGES')).toBe('changes');
  });

  it('ignores a verdict buried in a sentence', () => {
    expect(parseVerdict('I would not write VERDICT: APPROVE here')).toBe('unclear');
  });
});

describe('crossReview', () => {
  it('stops after one review when the reviewer approves', async () => {
    const claude = stub('claude', 'Draft v1');
    const gemini = stub('gemini', 'Fine.\nVERDICT: APPROVE');
    const room = new Room({ adapters: { claude, gemini }, cwd: '/w' });
    const result = await crossReview(room, { task: 'Write X', author: 'claude', reviewer: 'gemini' });

    expect(result).toMatchObject({ status: 'ok', final: 'Draft v1', verdict: 'approve' });
    expect(claude.requests).toHaveLength(1);
    expect(gemini.requests).toHaveLength(1);
    expect(gemini.requests[0]!.prompt).toContain('Draft v1');
    expect(gemini.requests[0]!.prompt).toContain('Write X');
  });

  it('has the author rewrite after a CHANGES verdict and reviews the rewrite', async () => {
    const claude = stub('claude', (_r, call) => reply(call === 1 ? 'Draft v1' : 'Draft v2'));
    const gemini = stub('gemini', (_r, call) => reply(call === 1 ? 'Bug in line 3.\nVERDICT: CHANGES' : 'Better.\nVERDICT: APPROVE'));
    const room = new Room({ adapters: { claude, gemini }, cwd: '/w' });
    const result = await crossReview(room, { task: 'Write X', author: 'claude', reviewer: 'gemini' });

    expect(result).toMatchObject({ status: 'ok', final: 'Draft v2', verdict: 'approve' });
    expect(result.steps.map((s) => s.provider)).toEqual(['claude', 'gemini', 'claude', 'gemini']);
    expect(claude.requests[1]!.prompt).toContain('Bug in line 3');
  });

  it('stops revising after maxRevisions and reports the last verdict', async () => {
    const claude = stub('claude', 'draft');
    const gemini = stub('gemini', 'No.\nVERDICT: CHANGES');
    const room = new Room({ adapters: { claude, gemini }, cwd: '/w' });
    const result = await crossReview(room, { task: 't', author: 'claude', reviewer: 'gemini', maxRevisions: 1 });
    expect(result.verdict).toBe('changes');
    expect(claude.requests).toHaveLength(2);
    expect(gemini.requests).toHaveLength(2);
  });

  it('never lets a model review its own answer', async () => {
    const claude = stub('claude', 'draft');
    const room = new Room({ adapters: { claude }, cwd: '/w' });
    const result = await crossReview(room, { task: 't', author: 'claude', reviewer: 'claude' });
    expect(result).toMatchObject({ status: 'error', error: expect.stringContaining('No reviewer other than Claude') });
    expect(claude.requests).toHaveLength(1);
  });

  it('reviews with the fallback when the author itself was swapped out', async () => {
    const claude = stub('claude', () => fail('usage limit reached'));
    const codex = stub('codex', 'Codex draft');
    const gemini = stub('gemini', 'ok\nVERDICT: APPROVE');
    const room = new Room({ adapters: { claude, codex, gemini }, cwd: '/w' });
    const result = await crossReview(room, { task: 't', author: ['claude', 'codex'], reviewer: ['codex', 'gemini'] });
    expect(result).toMatchObject({ status: 'ok', final: 'Codex draft' });
    // codex wrote the draft, so only gemini may review it
    expect(codex.requests).toHaveLength(1);
    expect(gemini.requests).toHaveLength(1);
  });

  it('fails when the author cannot answer, without calling the reviewer', async () => {
    const gemini = stub('gemini', 'x');
    const room = new Room({ adapters: { claude: stub('claude', () => fail('boom')), gemini }, cwd: '/w' });
    const result = await crossReview(room, { task: 't', author: 'claude', reviewer: 'gemini' });
    expect(result).toMatchObject({ status: 'error', error: 'boom' });
    expect(gemini.requests).toHaveLength(0);
  });

  it('reports cancellation instead of an error', async () => {
    const ac = new AbortController();
    ac.abort();
    const room = new Room({ adapters: { claude: stub('claude', 'x'), gemini: stub('gemini', 'y') }, cwd: '/w' });
    const result = await crossReview(room, { task: 't', author: 'claude', reviewer: 'gemini', signal: ac.signal });
    expect(result.status).toBe('cancelled');
  });

  it('keeps everyone read-only', async () => {
    const claude = stub('claude', 'd');
    const gemini = stub('gemini', 'VERDICT: APPROVE');
    await crossReview(new Room({ adapters: { claude, gemini }, cwd: '/w' }), { task: 't', author: 'claude', reviewer: 'gemini' });
    expect([...claude.requests, ...gemini.requests].every((r) => r.access === 'read-only')).toBe(true);
  });
});

describe('planExecute', () => {
  const adapters = () => ({
    claude: stub('claude', '1. Edit a.ts'),
    codex: stub('codex', 'Edited a.ts'),
    gemini: stub('gemini', 'Matches the plan.\nVERDICT: APPROVE'),
  });

  it('plans read-only, executes with the access the caller chose, then reviews', async () => {
    const a = adapters();
    const room = new Room({ adapters: a, cwd: '/w' });
    const result = await planExecute(room, { task: 'Rename foo', planner: 'claude', executor: 'codex', executorAccess: 'edit', reviewer: 'gemini' });

    expect(a.claude.requests[0]!.access).toBe('read-only');
    expect(a.codex.requests[0]!.access).toBe('edit');
    expect(a.gemini.requests[0]!.access).toBe('read-only');
    expect(a.codex.requests[0]!.prompt).toContain('1. Edit a.ts');
    expect(a.gemini.requests[0]!.prompt).toContain('Edited a.ts');
    expect(result).toMatchObject({ status: 'ok', verdict: 'approve' });
    expect(result.final).toContain('Edited a.ts');
    expect(result.final).toContain('Matches the plan');
  });

  it('works without a reviewer', async () => {
    const a = adapters();
    const result = await planExecute(new Room({ adapters: a, cwd: '/w' }), { task: 't', planner: 'claude', executor: 'codex', executorAccess: 'read-only' });
    expect(result).toMatchObject({ status: 'ok', final: 'Edited a.ts' });
    expect(a.gemini.requests).toHaveLength(0);
  });

  it('never runs the executor when there is no plan', async () => {
    const codex = stub('codex', 'x');
    const room = new Room({ adapters: { claude: stub('claude', () => fail('limit exceeded')), codex }, cwd: '/w' });
    const result = await planExecute(room, { task: 't', planner: 'claude', executor: 'codex', executorAccess: 'edit' });
    expect(result.status).toBe('error');
    expect(codex.requests).toHaveLength(0);
  });

  it('does not let the executor review itself', async () => {
    const a = adapters();
    const result = await planExecute(new Room({ adapters: a, cwd: '/w' }), {
      task: 't',
      planner: 'claude',
      executor: 'codex',
      executorAccess: 'edit',
      reviewer: 'codex',
    });
    expect(result.status).toBe('error');
  });
});

describe('debate', () => {
  it('first round is independent, later rounds see the others, and a judge closes', async () => {
    const claude = stub('claude', (_r, call) => reply(call === 1 ? 'Claude says A' : call === 2 ? 'Claude revised' : 'Final synthesis'));
    const gemini = stub('gemini', (_r, call) => reply(call === 1 ? 'Gemini says B' : 'Gemini revised'));
    const room = new Room({ adapters: { claude, gemini }, cwd: '/w' });
    const result = await debate(room, { question: 'A or B?', participants: ['claude', 'gemini'] });

    expect(claude.requests[0]!.prompt).not.toContain('Gemini says B');
    expect(gemini.requests[0]!.prompt).not.toContain('Claude says A');
    expect(claude.requests[1]!.prompt).toContain('Gemini says B');
    expect(gemini.requests[1]!.prompt).toContain('Claude says A');
    expect(claude.requests[2]!.prompt).toMatch(/Close the debate/);
    expect(result).toMatchObject({ status: 'ok', final: 'Final synthesis' });
    expect(result.steps).toHaveLength(5);
  });

  it('lets a participant that fails sit out instead of sinking the debate', async () => {
    const claude = stub('claude', 'Claude answer');
    const gemini = stub('gemini', () => fail('quota exhausted'));
    const codex = stub('codex', 'Codex answer');
    const room = new Room({ adapters: { claude, gemini, codex }, cwd: '/w' });
    const result = await debate(room, { question: 'q', participants: ['claude', 'gemini', 'codex'], rounds: 2 });

    expect(result.status).toBe('ok');
    expect(gemini.requests).toHaveLength(1);
    expect(codex.requests.length).toBeGreaterThanOrEqual(2);
  });

  it('the judge falls back to someone else when it cannot answer', async () => {
    const claude = stub('claude', (_r, call) => (call <= 2 ? reply('claude') : fail('limit reached')));
    const gemini = stub('gemini', 'gemini');
    const room = new Room({ adapters: { claude, gemini }, cwd: '/w' });
    const result = await debate(room, { question: 'q', participants: ['claude', 'gemini'], judge: 'claude' });
    expect(result).toMatchObject({ status: 'ok', final: 'gemini' });
  });

  it('fails when nobody can answer', async () => {
    const room = new Room({
      adapters: { claude: stub('claude', () => fail('boom')), gemini: stub('gemini', () => fail('bang')) },
      cwd: '/w',
    });
    const result = await debate(room, { question: 'q', participants: ['claude', 'gemini'] });
    expect(result).toMatchObject({ status: 'error', error: expect.stringContaining('Nobody could answer') });
  });

  it('needs two different participants', async () => {
    const room = new Room({ adapters: { claude: stub('claude', 'x') }, cwd: '/w' });
    expect(await debate(room, { question: 'q', participants: ['claude', 'claude'] })).toMatchObject({ status: 'error' });
  });
});
