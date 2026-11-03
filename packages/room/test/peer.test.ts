import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { afterAll, describe, expect, it } from 'vitest';
import { createPeerServer, FileTranscript, MemoryTranscript, peerServerSpec } from '../src/index.js';
import type { PeerServerOptions, TranscriptStore } from '../src/index.js';
import { fail, stub } from './helpers.js';

const dirs: string[] = [];
afterAll(() => Promise.all(dirs.map((d) => rm(d, { recursive: true, force: true }))));

async function connect(overrides: Partial<PeerServerOptions> & Pick<PeerServerOptions, 'adapters'>) {
  const transcript: TranscriptStore = overrides.transcript ?? new MemoryTranscript();
  const server = createPeerServer({ self: 'claude', peers: ['gemini', 'codex'], transcript, cwd: '/w', maxAsks: 2, ...overrides });
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test', version: '0' });
  await Promise.all([server.connect(a), client.connect(b)]);
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const r = (await client.callTool({ name, arguments: args })) as { isError?: boolean; content: { type: string; text: string }[] };
    return { isError: r.isError === true, text: r.content.map((c) => c.text).join('\n') };
  };
  return { call, client, transcript };
}

describe('room peer server', () => {
  it('exposes exactly the three room tools', async () => {
    const { client } = await connect({ adapters: {} });
    expect((await client.listTools()).tools.map((t) => t.name).sort()).toEqual(['ask_peer', 'post_to_room', 'read_room']);
  });

  it('ask_peer runs the peer read-only and without any MCP server, and records both sides', async () => {
    const gemini = stub('gemini', 'Use a mutex.');
    const { call, transcript } = await connect({ adapters: { gemini } });
    const r = await call('ask_peer', { peer: 'gemini', question: 'How do I avoid the race?' });

    expect(r).toEqual({ isError: false, text: 'Use a mutex.' });
    const req = gemini.requests[0]!;
    expect(req.access).toBe('read-only');
    expect(req.mcpServers).toBeUndefined();
    expect(req.prompt).toContain('How do I avoid the race?');
    expect((await transcript.list()).map((m) => [m.author, m.text])).toEqual([
      ['claude', '(to gemini) How do I avoid the race?'],
      ['gemini', 'Use a mutex.'],
    ]);
  });

  it('refuses to ask itself, or someone outside the room', async () => {
    const { call, client } = await connect({ adapters: { gemini: stub('gemini', 'x') } });
    expect(await call('ask_peer', { peer: 'claude', question: 'hi' })).toMatchObject({ isError: true });
    // The schema only admits the listed peers, so the protocol layer rejects anything else.
    const outside = await client.callTool({ name: 'ask_peer', arguments: { peer: 'mallory', question: 'hi' } }).catch(() => ({ isError: true }));
    expect(outside.isError).toBe(true);
  });

  it('stops after the question limit so models cannot loop on each other', async () => {
    const gemini = stub('gemini', 'ok');
    const { call } = await connect({ adapters: { gemini }, maxAsks: 2 });
    expect((await call('ask_peer', { peer: 'gemini', question: '1' })).isError).toBe(false);
    expect((await call('ask_peer', { peer: 'gemini', question: '2' })).isError).toBe(false);
    const third = await call('ask_peer', { peer: 'gemini', question: '3' });
    expect(third.isError).toBe(true);
    expect(third.text).toMatch(/limit/i);
    expect(gemini.requests).toHaveLength(2);
  });

  it('counts a failed question against the limit too', async () => {
    const { call } = await connect({ adapters: { gemini: stub('gemini', () => fail('quota exhausted')) }, maxAsks: 1 });
    const first = await call('ask_peer', { peer: 'gemini', question: 'a' });
    expect(first).toMatchObject({ isError: true });
    expect(first.text).toContain('quota exhausted');
    expect((await call('ask_peer', { peer: 'gemini', question: 'b' })).text).toMatch(/limit/i);
  });

  it('read_room shows the transcript and post_to_room signs the message with the caller', async () => {
    const transcript = new MemoryTranscript();
    await transcript.append({ author: 'user', text: 'The task' });
    const { call } = await connect({ adapters: {}, transcript });

    expect((await call('post_to_room', { text: 'My finding' })).isError).toBe(false);
    const room = await call('read_room');
    expect(room.text).toContain('The task');
    expect(room.text).toContain('claude:\nMy finding');
  });

  it('rejects an oversized post', async () => {
    const { call } = await connect({ adapters: {} });
    expect(await call('post_to_room', { text: 'x'.repeat(9_000) })).toMatchObject({ isError: true });
  });

  it('shares the room with another process through the transcript file', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'aio-peer-test-'));
    dirs.push(dir);
    const file = path.join(dir, 'room.jsonl');
    const { call } = await connect({ adapters: {}, transcript: new FileTranscript(file) });
    await call('post_to_room', { text: 'seen by the orchestrator' });
    expect((await new FileTranscript(file).list()).map((m) => m.text)).toEqual(['seen by the orchestrator']);
  });
});

describe('the server as a real process', () => {
  it('starts from the spec the room hands to a CLI and shares the room file', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'aio-peer-proc-'));
    dirs.push(dir);
    const file = path.join(dir, 'room.jsonl');
    const spec = peerServerSpec({ self: 'claude', peers: ['gemini'], transcriptFile: file, cwd: dir });
    const client = new Client({ name: 'test', version: '0' });
    // Same shape a CLI uses: the command and args from the spec, plus only the env the spec carries.
    await client.connect(new StdioClientTransport({ command: spec.command, args: spec.args, env: spec.env, stderr: 'pipe' }));
    try {
      expect((await client.listTools()).tools.map((t) => t.name).sort()).toEqual(['ask_peer', 'post_to_room', 'read_room']);
      await client.callTool({ name: 'post_to_room', arguments: { text: 'from the child process' } });
    } finally {
      await client.close();
    }
    expect((await new FileTranscript(file).list()).map((m) => [m.author, m.text])).toEqual([['claude', 'from the child process']]);
  }, 30_000);
});

describe('peerServerSpec', () => {
  it('describes a node process that needs nothing secret', () => {
    const spec = peerServerSpec({ self: 'codex', peers: ['claude', 'gemini'], transcriptFile: '/r/room.jsonl', cwd: '/w', entry: '/x/peer-main.js' });
    expect(spec).toMatchObject({ name: 'room', command: process.execPath, args: ['/x/peer-main.js'] });
    expect(spec.env).toMatchObject({ AIO_ROOM_SELF: 'codex', AIO_ROOM_PEERS: 'claude,gemini', AIO_ROOM_MAX_ASKS: '6' });
    expect(Object.keys(spec.env!).every((k) => k.startsWith('AIO_ROOM_'))).toBe(true);
  });

  it('loads TypeScript entries through tsx', () => {
    const spec = peerServerSpec({ self: 'claude', peers: ['gemini'], transcriptFile: '/r', cwd: '/w', entry: '/x/peer-main.ts' });
    expect(spec.args![0]).toBe('--import');
    expect(spec.args!.at(-1)).toBe('/x/peer-main.ts');
  });
});
