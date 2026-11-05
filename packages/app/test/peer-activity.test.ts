import { appendFile, stat } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { parsePeerActivity, watchPeerActivity } from '../src/services/peer-activity.js';
import { makeApp, stub } from './helpers.js';
import { fileActivitySink } from '@aio/room';

describe('MCP visual activity bridge', () => {
  it('validates metadata and discards unknown providers and activity values', () => {
    expect(parsePeerActivity('{')).toBeUndefined();
    expect(parsePeerActivity(JSON.stringify({ self: 'claude', peer: 'evil', activity: 'thinking' }))).toBeUndefined();
    expect(parsePeerActivity(JSON.stringify({ self: 'claude', peer: 'claude', activity: 'thinking' }))).toBeUndefined();
    expect(parsePeerActivity(JSON.stringify({ self: 'claude', peer: 'gemini', activity: 'thinking', prompt: 'private' })))
      .toEqual({ self: 'claude', peer: 'gemini', activity: 'thinking' });
  });
  it('flushes complete rows once, ignores partial or invalid rows, and removes the temporary journal', async () => {
    const events: unknown[] = [];
    const journal = await watchPeerActivity((event) => events.push(event));
    const line = JSON.stringify({ self: 'claude', peer: 'gemini', activity: 'thinking' });
    await appendFile(journal.file, `${line}\ninvalid\n{"partial":`);
    await journal.close();
    expect(events).toEqual([{ self: 'claude', peer: 'gemini', activity: 'thinking' }]);
    await expect(stat(journal.file)).rejects.toThrow();
  });
  it('relays a peer process journal under the correct run before run_done', async () => {
    const claude = stub('claude', (req) => {
      const file = req.mcpServers?.find((s) => s.name === 'room')?.env?.AIO_ROOM_ACTIVITY_FILE;
      // The fake CLI writes the same metadata as the real MCP server.
      if (file) fileActivitySink(file)({ self: 'claude', peer: 'gemini', activity: 'thinking' });
      return [{ type: 'done', status: 'ok', text: 'Done' }];
    });
    const { app, events, workdir, done } = await makeApp({ adapters: { claude, gemini: stub('gemini', 'Peer') } });
    const conv = await app.createConversation({ cwd: workdir });
    const { runId } = await app.startRun({ conversationId: conv.id, prompt: 'Ask Gemini', connections: [], peerTools: true,
      spec: { kind: 'lead', lead: { provider: 'claude' }, team: [{ provider: 'gemini' }], fallback: false, access: 'read-only' } });
    await done(conv.id);
    const activity = events.findIndex((event) => event.type === 'peer_activity');
    expect(activity).toBeGreaterThanOrEqual(0);
    expect(events[activity]).toMatchObject({ type: 'peer_activity', runId, conversationId: conv.id, peer: 'gemini', activity: 'thinking' });
    expect(activity).toBeLessThan(events.findIndex((event) => event.type === 'run_done'));
  });
});
