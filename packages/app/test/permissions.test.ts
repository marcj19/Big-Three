import { describe, expect, it, vi } from 'vitest';
import { API_METHODS, PERMISSION_KEYS, PERMISSION_SUPPORT, type StartRun } from '../src/shared/api.js';
import { makeApp, stub } from './helpers.js';

const chat = (conversationId: string, over: Partial<StartRun> = {}): StartRun => ({
  conversationId,
  prompt: 'Hello',
  spec: { kind: 'chat', providers: ['claude'], access: 'read-only' },
  connections: [],
  peerTools: false,
  ...over,
});

describe('web and browser permissions', () => {
  it('start off, and the window can only reach them through the confirmed methods', async () => {
    const { app, workdir } = await makeApp({ adapters: { claude: stub('claude', 'x') } });
    const conv = await app.createConversation({ cwd: workdir });
    expect(await app.getPermissions(conv.id)).toEqual({ web: false, browser: false });
    expect(API_METHODS).toContain('getPermissions');
    expect(API_METHODS).toContain('setPermission');
  });

  it('cannot be turned on when nothing confirms it', async () => {
    const { app, workdir } = await makeApp({ adapters: { claude: stub('claude', 'x') } });
    const conv = await app.createConversation({ cwd: workdir });
    await expect(app.setPermission(conv.id, 'web', true)).rejects.toThrow(/not confirmed/);
    await expect(app.setPermission(conv.id, 'browser', true)).rejects.toThrow(/not confirmed/);
    expect(await app.getPermissions(conv.id)).toEqual({ web: false, browser: false });
  });

  it('asks the person with the permission and the folder, respects a no, and never asks to turn one off', async () => {
    const confirmPermission = vi.fn(async ({ permission }: { permission: string }) => permission === 'web');
    const { app, workdir } = await makeApp({ adapters: { claude: stub('claude', 'x') }, confirmPermission });
    const conv = await app.createConversation({ cwd: workdir });

    expect(await app.setPermission(conv.id, 'web', true)).toEqual({ web: true, browser: false });
    expect(confirmPermission).toHaveBeenCalledWith(expect.objectContaining({ permission: 'web', cwd: conv.cwd }));
    await expect(app.setPermission(conv.id, 'browser', true)).rejects.toThrow(/not confirmed/);
    expect(await app.getPermissions(conv.id)).toEqual({ web: true, browser: false });

    expect(await app.setPermission(conv.id, 'web', false)).toEqual({ web: false, browser: false });
    expect(confirmPermission).toHaveBeenCalledTimes(2); // turning it off asked nothing
    // Already on means nothing to confirm again.
    await app.setPermission(conv.id, 'web', true);
    await app.setPermission(conv.id, 'web', true);
    expect(confirmPermission).toHaveBeenCalledTimes(3);
  });

  it('are kept per conversation, and a restart puts them back to off', async () => {
    const options = { adapters: { claude: stub('claude', 'x') }, confirmPermission: async () => true };
    const { app, workdir, configDir } = await makeApp(options);
    const a = await app.createConversation({ cwd: workdir });
    const b = await app.createConversation({ cwd: workdir });
    await app.setPermission(a.id, 'web', true);
    expect(await app.getPermissions(b.id)).toEqual({ web: false, browser: false });
    const restarted = await makeApp({ ...options, configDir });
    expect(await restarted.app.getPermissions(a.id)).toEqual({ web: false, browser: false });
  });

  it('reach the model for the run, and are not the window\'s to claim', async () => {
    const claude = stub('claude', 'OK');
    const { app, workdir, done } = await makeApp({ adapters: { claude }, confirmPermission: async () => true });
    const conv = await app.createConversation({ cwd: workdir });

    await app.startRun(chat(conv.id));
    await done(conv.id);
    expect(claude.requests[0]!.permissions).toEqual({ web: false, browser: false });

    await app.setPermission(conv.id, 'web', true);
    await app.startRun(chat(conv.id, { prompt: 'again', ...({ permissions: { web: true, browser: true } } as object) }));
    await vi.waitFor(() => expect(claude.requests).toHaveLength(2));
    // Whatever the window puts in the request, the main process's own state decides.
    expect(claude.requests[1]!.permissions).toEqual({ web: true, browser: false });
  });

  it('cannot change while a run is going', async () => {
    const claude = stub('claude', 'slow', { delayMs: 300 });
    const { app, workdir } = await makeApp({ adapters: { claude }, confirmPermission: async () => true });
    const conv = await app.createConversation({ cwd: workdir });
    await app.startRun(chat(conv.id));
    await expect(app.setPermission(conv.id, 'web', true)).rejects.toThrow(/depois que a execução terminar/);
  });

  it('only claims support where the CLIs can enforce it', () => {
    expect([...PERMISSION_KEYS]).toEqual(['web', 'browser']);
    expect(PERMISSION_SUPPORT.web).toEqual(['claude', 'codex']);
    expect(PERMISSION_SUPPORT.browser).toEqual(['claude']);
  });
});
