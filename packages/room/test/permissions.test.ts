import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterAll, describe, expect, it } from 'vitest';
import { createPeerServer, FileTranscript, MemoryTranscript, peerServerSpec, Room } from '../src/index.js';
import { stub } from './helpers.js';

const dirs: string[] = [];
afterAll(() => Promise.all(dirs.map((d) => rm(d, { recursive: true, force: true }))));
const tmp = async () => { const d = await mkdtemp(path.join(os.tmpdir(), 'aio-perm-')); dirs.push(d); return d; };

describe('permissions in the room', () => {
  it('hands the permissions of a turn to the model, and nothing when none were granted', async () => {
    const claude = stub('claude', 'ok');
    const room = new Room({ adapters: { claude }, cwd: await tmp() });
    await room.say('hi');
    await room.turn('claude', 'Answer');
    await room.turn('claude', 'Answer', { permissions: { web: true, browser: true } });
    expect(claude.requests[0]!.permissions).toBeUndefined();
    expect(claude.requests[1]!.permissions).toEqual({ web: true, browser: true });
  });

  it('tells the peer server about the web only, and only when the lead has it', async () => {
    expect(peerServerSpec({ self: 'claude', peers: ['gemini'], transcriptFile: '/r', cwd: '/w', entry: '/x/peer-main.js', web: true }).env).toMatchObject({ AIO_ROOM_WEB: '1' });
    expect(peerServerSpec({ self: 'claude', peers: ['gemini'], transcriptFile: '/r', cwd: '/w', entry: '/x/peer-main.js' }).env).not.toHaveProperty('AIO_ROOM_WEB');

    const dir = await tmp();
    const claude = stub('claude', 'ok');
    const room = new Room({ adapters: { claude, gemini: stub('gemini', 'x') }, cwd: dir, transcript: new FileTranscript(path.join(dir, 'r.jsonl')), peerServer: { team: { gemini: {} } } });
    await room.say('hi');
    await room.turn('claude', 'Answer', { withPeerTools: true, permissions: { web: true, browser: true } });
    await room.turn('claude', 'Answer', { withPeerTools: true, permissions: { browser: true } });
    const env = (i: number) => claude.requests[i]!.mcpServers![0]!.env!;
    expect(env(0).AIO_ROOM_WEB).toBe('1');
    expect(env(1).AIO_ROOM_WEB).toBeUndefined();
  });

  it('a consulted colleague gets the web when the lead has it, and never the browser', async () => {
    const consult = async (permissions: { web?: boolean; browser?: boolean } | undefined) => {
      const gemini = stub('gemini', 'ok');
      const server = createPeerServer({ self: 'claude', peers: ['gemini'], adapters: { gemini }, transcript: new MemoryTranscript(), cwd: await tmp(), maxAsks: 1, permissions });
      const [a, b] = InMemoryTransport.createLinkedPair();
      const client = new Client({ name: 'test', version: '0' });
      await Promise.all([server.connect(a), client.connect(b)]);
      await client.callTool({ name: 'ask_peer', arguments: { peer: 'gemini', question: 'q' } });
      await client.close();
      return gemini.requests[0]!.permissions;
    };
    expect(await consult({ web: true, browser: true })).toEqual({ web: true });
    expect(await consult({ browser: true })).toBeUndefined();
    expect(await consult(undefined)).toBeUndefined();
  });
});
