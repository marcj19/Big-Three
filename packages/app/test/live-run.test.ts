import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { describe, expect, it, vi } from 'vitest';
import type { AppEvent, StartRun } from '../src/shared/api.js';
import { makeApp, stub } from './helpers.js';

const task = (conversationId: string): StartRun => ({
  conversationId,
  prompt: 'Implemente a interface',
  connections: [],
  peerTools: false,
  spec: { kind: 'lead', lead: { provider: 'claude' }, access: 'edit', team: [], fallback: false },
});

async function waitForQuestion(events: AppEvent[]) {
  return vi.waitFor(() => {
    const event = events.find((entry) => entry.type === 'question');
    expect(event).toBeDefined();
    return event!;
  });
}

describe('live project runs', () => {
  it('publishes activity and a saved prompt before completion, waits for the answer, then offers the reachable preview', async () => {
    const server = createServer((_req, res) => res.end('Project preview'));
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    try {
      const url = 'http://127.0.0.1:' + (server.address() as AddressInfo).port + '/';
      const summary = '|Pronto — **interface revisada**.\n\n#### O que mudou\n\n- Layout da navegação.';
      const savedReply = summary + '\n\nQual tema?';
      const claude = stub('claude', (request) => request.prompt.includes('Escuro') ? [
        { type: 'preview', url },
        { type: 'done', status: 'ok', text: 'Prévia pronta: ' + url },
      ] : [
        { type: 'subagent', agentId: 'layout', label: 'Revisar layout', status: 'running' },
        { type: 'subagent', agentId: 'layout', label: 'Revisar layout', status: 'done' },
        { type: 'done', status: 'ok', text: summary + '\n\n\\<aio-question>{"question":"Qual tema?","options":["Claro","Escuro"]}\\</aio-question>' },
      ]);
      const { app, events, workdir, done } = await makeApp({ adapters: { claude }, confirmAccess: async () => true });
      const conv = await app.createConversation({ cwd: workdir });
      const { runId } = await app.startRun(task(conv.id));
      const request = await waitForQuestion(events);
      expect(request).toMatchObject({ runId, question: { provider: 'claude', question: 'Qual tema?', options: ['Claro', 'Escuro'] } });
      expect(events[0]).toMatchObject({ type: 'transcript', runId });
      expect(events.some((event) => event.type === 'run_done')).toBe(false);
      expect((await app.getConversation(conv.id)).messages.map((message) => message.text)).toEqual(['Implemente a interface', savedReply]);
      expect((await app.runHistory(conv.id))[0]?.entries).toEqual(expect.arrayContaining([
        expect.objectContaining({ kind: 'subagent', label: 'Revisar layout', status: 'done' }),
        expect.objectContaining({ kind: 'question', status: 'running' }),
      ]));

      await app.answerQuestion(runId, request.question.id, 'Escuro');
      await expect(app.answerQuestion(runId, request.question.id, 'Claro')).rejects.toThrow(/já foi respondida/);
      expect((await done(conv.id)).outcome.status).toBe('ok');
      expect(claude.requests).toHaveLength(2);
      expect(claude.requests[1]?.access).toBe('edit');
      expect((await app.getConversation(conv.id)).messages.map((message) => message.text)).toEqual(['Implemente a interface', savedReply, 'Escuro', 'Prévia pronta: ' + url]);
      expect(events.filter((event) => event.type === 'project_preview')).toEqual([{ type: 'project_preview', runId, conversationId: conv.id, url }]);
      expect(events.findIndex((event) => event.type === 'project_preview')).toBeLessThan(events.findIndex((event) => event.type === 'run_done'));
      expect((await app.runHistory(conv.id))[0]?.previewUrl).toBe(url);
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });

  it('releases a run cancelled while the model is waiting for a reply', async () => {
    const claude = stub('claude', () => [{ type: 'question', question: 'Qual tema?' }]);
    const { app, events, workdir, done } = await makeApp({ adapters: { claude }, confirmAccess: async () => true });
    const conv = await app.createConversation({ cwd: workdir });
    const { runId } = await app.startRun(task(conv.id));
    const request = await waitForQuestion(events);
    await app.cancelRun(runId);
    expect((await done(conv.id)).outcome.status).toBe('cancelled');
    await expect(app.answerQuestion(runId, request.question.id, 'Escuro')).rejects.toThrow(/execução foi encerrada/);
    expect(claude.requests).toHaveLength(1);
  });
});
