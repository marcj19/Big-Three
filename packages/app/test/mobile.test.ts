import { randomBytes, randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { derivePairing, MobileGateway, mobileHash, open, seal, type CompanionSession } from '../src/services/mobile.js';
import { mobileOffice } from '../src/shared/mobile-office.js';
import { newRunRecord, recordWork } from '../src/shared/work-trace.js';
import { makeApp, stub } from './helpers.js';

describe('mobile companion', () => {
  it('shows what each model is doing and clears the office after the run', () => {
    const conversationId = randomUUID();
    const titles = new Map([[conversationId, 'Revisar o projeto']]);
    const run = newRunRecord(randomUUID(), { conversationId, prompt: 'Revise o projeto' });
    recordWork(run, { type: 'room', event: { type: 'tool_call', provider: 'codex', name: 'read_file' } });
    recordWork(run, { type: 'peer_activity', self: 'claude', peer: 'gemini', activity: 'thinking' });

    expect(mobileOffice([run], titles)).toEqual([
      { id: 'claude', status: 'consulting', label: 'Claude → Gemini', conversationId, conversation: 'Revisar o projeto' },
      { id: 'gemini', status: 'reviewing', label: 'Analisando uma consulta', conversationId, conversation: 'Revisar o projeto' },
      { id: 'codex', status: 'reading', label: 'Lendo arquivos', conversationId, conversation: 'Revisar o projeto' },
    ]);

    run.status = 'ok';
    expect(mobileOffice([run], titles)).toEqual(['claude', 'gemini', 'codex'].map((id) => ({ id, status: 'idle', label: 'Aguardando uma tarefa' })));
  });

  it('restores a desktop session and only answers authenticated, read-only requests', async () => {
    let saved: CompanionSession | undefined;
    const queued: { id: string; payload: string }[] = [];
    const replies: { exchange: string; payload: string }[] = [];
    const transmitted: string[] = [];
    const conversation = randomUUID();
    const app = { mobileConversations: vi.fn(async () => ({ conversations: [], office: [] })),
      mobileConversation: vi.fn(async () => ({ title: 'Conversa privada', busy: false, messages: [], activity: null })),
      mobileStartPrompt: vi.fn(async () => ({ status: 202, data: { runId: randomUUID() } })) };
    const options = { relayUrl: 'http://relay.test', load: async () => saved,
      save: async (value: CompanionSession | undefined) => { saved = value; } };
    vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
      transmitted.push(init.body?.toString() ?? '');
      if (url.endsWith('/next')) {
        await new Promise((resolve) => setTimeout(resolve, 10));
        init.signal?.throwIfAborted();
        return Response.json({ paired: !!queued.length || !!replies.length, request: queued.shift() });
      }
      if (url.endsWith('/reply')) replies.push(JSON.parse(init.body!.toString()));
      return Response.json({ expiresAt: Date.now() + 60_000 });
    }));
    const first = new MobileGateway(app, options);
    const restored = new MobileGateway(app, options);
    try {
      const code = (await first.manage('pair')).pairing!.code;
      const { id, claim, key } = derivePairing(code);
      expect(JSON.parse(transmitted[0]!)).toEqual({ id, verifier: mobileHash(claim) });
      expect(saved?.key).toBe(key);
      first.shutdown();
      await restored.restore();
      const read = randomUUID(), bad = randomUUID();
      queued.push({ id: read, payload: seal(key, read, 'read', JSON.stringify({ conversationId: conversation })) },
        { id: bad, payload: seal(key, read, 'read', '{}') });
      await vi.waitFor(() => expect(replies).toHaveLength(2));
      expect(open(key, read, 'reply', replies[0]!.payload)).toMatchObject({ status: 200, data: { title: 'Conversa privada' } });
      expect(open(key, bad, 'reply', replies[1]!.payload)).toEqual({ status: 400 });
      expect(app.mobileConversation).toHaveBeenCalledExactlyOnceWith(conversation);
      expect(app.mobileConversations).not.toHaveBeenCalled();
      expect(transmitted.join('')).not.toContain('Conversa privada');
      expect(transmitted.join('')).not.toContain(code);
      const exchange = async (input: unknown, id = randomUUID()) => {
        const index = replies.length;
        queued.push({ id, payload: seal(key, id, 'read', JSON.stringify(input)) });
        await vi.waitFor(() => expect(replies).toHaveLength(index + 1));
        return open(key, id, 'reply', replies[index]!.payload);
      };
      const prompt = { op: 'prompt', permit: randomBytes(32).toString('base64url'), conversationId: conversation, provider: 'claude', prompt: 'Pedido privado' };
      expect(await exchange(prompt)).toMatchObject({ status: 403 });
      expect(app.mobileStartPrompt).not.toHaveBeenCalled();
      expect((await restored.manage('allow-prompts')).allowPrompts).toBe(true);
      expect(saved?.allowPrompts).toBe(true);
      const detail = await exchange({ conversationId: conversation }) as { data: { promptPermit: string } };
      prompt.permit = detail.data.promptPermit;
      expect(await exchange({ ...prompt, access: 'full' })).toEqual({ status: 400 });
      const submission = randomUUID();
      const accepted = await exchange(prompt, submission);
      expect(accepted).toMatchObject({ status: 202 });
      expect(await exchange(prompt, submission)).toEqual(accepted);
      expect(await exchange(prompt)).toMatchObject({ status: 409 });
      expect(app.mobileStartPrompt).toHaveBeenCalledTimes(1);
      expect(transmitted.join('')).not.toContain('Pedido privado');
      expect((await restored.manage('block-prompts')).allowPrompts).toBe(false);
      expect(await exchange(prompt, submission)).toMatchObject({ status: 403 });
      await restored.manage('stop');
      expect(saved).toBeUndefined();
      expect(restored.state().enabled).toBe(false);
    } finally {
      first.shutdown(); restored.shutdown(); vi.unstubAllGlobals();
    }
  });

  it('launches Android prompts with desktop read-only permissions and publishes the run on the desktop', async () => {
    const claude = stub('claude', 'Resposta do PC', { delayMs: 250 });
    const { app, events, done, workdir } = await makeApp({ adapters: { claude }, confirmAccess: async () => true });
    const conversation = await app.createConversation({ cwd: workdir });
    await app.setConversationAccess(conversation.id, 'full');
    const input = { conversationId: conversation.id, provider: 'claude', prompt: 'Prompt enviado do Android' } as const;
    expect(await app.mobileStartPrompt(input, () => false)).toMatchObject({ status: 403 });
    expect(await app.mobileStartPrompt(input, () => true)).toMatchObject({ status: 202 });
    expect(await app.mobileStartPrompt(input, () => true)).toMatchObject({ status: 409 });
    await done(conversation.id);
    expect(events[0]).toMatchObject({ type: 'mobile_run_started', conversationId: conversation.id, prompt: input.prompt });
    expect(claude.requests[0]).toMatchObject({ access: 'read-only' });
    expect(claude.requests[0]?.mcpServers ?? []).toEqual([]);
    expect((await app.getConversation(conversation.id)).messages).toEqual(expect.arrayContaining([
      expect.objectContaining({ author: 'user', text: input.prompt }), expect.objectContaining({ author: 'claude', text: 'Resposta do PC' }),
    ]));
  });
});
