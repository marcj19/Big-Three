import { EventEmitter } from 'node:events';
import type { AppUpdater } from 'electron-updater';
import { expect, it, vi } from 'vitest';
import { AppUpdates } from '../src/main/updates.js';
import { makeApp, stub } from './helpers.js';

it('checks, downloads, and installs in separate steps', async () => {
  const backend = Object.assign(new EventEmitter(), {
    checkForUpdates: vi.fn(async () => {
      backend.emit('update-available', { version: '0.3.0' });
      return {};
    }),
    downloadUpdate: vi.fn(async () => {
      backend.emit('download-progress', { percent: 42.4 });
      backend.emit('update-downloaded', { version: '0.3.0' });
    }),
    quitAndInstall: vi.fn(),
  });
  const notify = vi.fn();
  const updates = new AppUpdates('0.2.0', backend as unknown as AppUpdater, notify);
  expect(await updates.perform('check')).toMatchObject({ phase: 'available', version: '0.2.0', availableVersion: '0.3.0' });
  expect(backend.downloadUpdate).not.toHaveBeenCalled();
  expect(await updates.perform('download')).toMatchObject({ phase: 'ready' });
  expect(notify).toHaveBeenCalledWith(expect.objectContaining({ phase: 'downloading', percent: 42 }));
  expect(backend.quitAndInstall).not.toHaveBeenCalled();
  expect(await updates.perform('install')).toMatchObject({ phase: 'installing' });
  expect(backend.quitAndInstall).toHaveBeenCalledOnce();
});

it('waits for running tasks before starting an update installation', async () => {
  const perform = vi.fn(async () => ({ phase: 'installing' as const }));
  const { app, workdir, done } = await makeApp({
    adapters: { claude: stub('claude', 'Answer', { delayMs: 100 }) },
    updates: { state: () => ({ phase: 'ready' }), perform },
  });
  const conversation = await app.createConversation({ cwd: workdir });
  await app.startRun({
    conversationId: conversation.id, prompt: 'Review the project', connections: [], peerTools: false,
    spec: { kind: 'chat', providers: ['claude'], access: 'read-only' },
  });
  await expect(app.update('install')).rejects.toThrow(/Aguarde a tarefa terminar/);
  expect(perform).not.toHaveBeenCalled();
  await done(conversation.id);
  expect(await app.update('install')).toEqual({ phase: 'installing' });
  expect(perform).toHaveBeenCalledWith('install');
});
