import { describe, expect, it } from 'vitest';
import { MobileGateway } from '../src/services/mobile.js';
import { makeApp, stub } from './helpers.js';

describe('mobile pairing', () => {
  it('exchanges a one-time token, reads the live desktop run and revokes access', async () => {
    const claude = stub('claude', 'Resposta de teste.', { delayMs: 1200 });
    const { app, workdir, done } = await makeApp({ adapters: { claude } });
    const conv = await app.createConversation({ cwd: workdir, title: 'Teste do Android' });
    const gateway = new MobileGateway(app, 0);
    expect(gateway.state().enabled).toBe(false);

    const state = await gateway.manage('pair');
    const code = state.pairing!.code;
    const base = `http://127.0.0.1:${state.port}`;
    const detail = `/v1/conversations/${conv.id}`;
    const login = 'phone@example.invalid';
    const call = (route: string, token?: string, method = 'GET', identity = login) => fetch(base + route, {
      method, headers: { ...(identity ? { 'tailscale-user-login': identity } : {}), ...(token ? { authorization: `Bearer ${token}` } : {}) },
    });
    try {
      expect((await call('/v1/conversations?token=' + code)).status).toBe(401);
      expect((await call('/v1/conversations', code)).status).toBe(401);
      expect((await call('/v1/pair', code, 'POST', '')).status).toBe(403);
      const paired = await call('/v1/pair', code, 'POST');
      expect(paired.status).toBe(200);
      const { credential } = await paired.json() as { credential: string };
      expect(credential).not.toBe(code);
      expect((await call('/v1/pair', code, 'POST')).status).toBe(401);
      expect((await call(detail, credential, 'GET', '')).status).toBe(403);
      expect((await call(detail, credential, 'GET', 'other@example.invalid')).status).toBe(401);
      expect(gateway.state()).toMatchObject({ paired: true, pairing: undefined });
      expect((await call('/v1/conversations', credential, 'POST')).status).toBe(405);
      expect((await call('/api/startRun', credential)).status).toBe(404);

      await app.startRun({ conversationId: conv.id, prompt: 'Conte uma novidade.',
        spec: { kind: 'chat', providers: ['claude'], access: 'read-only' }, connections: [], peerTools: false });
      const list = await (await call('/v1/conversations', credential)).json() as { conversations: object[] };
      expect(list.conversations[0]).toEqual({ id: conv.id, title: 'Teste do Android', updatedAt: expect.any(String), running: true });
      expect(await (await call(detail, credential)).json()).toMatchObject({ activity: { status: 'running' } });
      await done(conv.id);
      const finished = await (await call(detail, credential)).json();
      expect(finished).toMatchObject({ activity: { status: 'ok' }, messages: [
        { author: 'user', text: 'Conte uma novidade.' }, { author: 'claude', text: 'Resposta de teste.' },
      ] });
      expect(JSON.stringify(finished)).not.toContain(workdir);
      const snapshot = await call(detail, credential);
      const tag = snapshot.headers.get('etag')!;
      await snapshot.json();
      expect(tag).toBeTruthy();
      expect((await fetch(base + detail, { headers: { authorization: `Bearer ${credential}`, 'tailscale-user-login': login, 'if-none-match': tag } })).status).toBe(304);

      const another = await gateway.manage('pair');
      expect((await call('/v1/pair', another.pairing!.code, 'POST')).status).toBe(200);
      expect((await call(detail, credential)).status).toBe(401);
      expect((await gateway.manage('stop')).enabled).toBe(false);
      await expect(call(detail, credential)).rejects.toThrow();
    } finally { gateway.stop(); }
  });
});
