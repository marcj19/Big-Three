import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { derivePairing, MobileGateway, mobileHash, open, seal, type CompanionSession } from '../src/services/mobile.js';

describe('mobile companion', () => {
  it('restores a desktop session and only answers authenticated, read-only requests', async () => {
    let saved: CompanionSession | undefined;
    const queued: { id: string; payload: string }[] = [];
    const replies: { exchange: string; payload: string }[] = [];
    const transmitted: string[] = [];
    const conversation = randomUUID();
    const app = { mobileConversations: vi.fn(async () => ({ conversations: [] })),
      mobileConversation: vi.fn(async () => ({ title: 'Conversa privada', messages: [], activity: null })) };
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
      await restored.manage('stop');
      expect(saved).toBeUndefined();
      expect(restored.state().enabled).toBe(false);
    } finally {
      first.shutdown(); restored.shutdown(); vi.unstubAllGlobals();
    }
  });
});
