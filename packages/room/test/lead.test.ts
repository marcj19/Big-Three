import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterAll, describe, expect, it } from 'vitest';
import { createPeerServer, FileTranscript, MemoryTranscript, peerServerSpec, Room } from '../src/index.js';
import { fail, reply, stub } from './helpers.js';

const dirs: string[] = [];
afterAll(() => Promise.all(dirs.map((d) => rm(d, { recursive: true, force: true }))));
const tmpFile = async () => {
  const d = await mkdtemp(path.join(os.tmpdir(), 'aio-lead-'));
  dirs.push(d);
  return path.join(d, 'room.jsonl');
};

describe('the lead and its team', () => {
  it('tells the lead who is on the team and when to consult them', async () => {
    const claude = stub('claude', 'a');
    const room = new Room({
      adapters: { claude, gemini: stub('gemini', 'b'), codex: stub('codex', 'c') },
      cwd: '/w',
      transcript: new FileTranscript(await tmpFile()),
      peerServer: { entry: '/x/peer-main.js', team: { gemini: { model: 'gemini-4-argon-high' } } },
    });
    await room.turn('claude', 'go', { withPeerTools: true });
    const system = claude.requests[0]!.systemPrompt!;
    expect(system).toMatch(/lead of a small team/);
    expect(system).toContain('Gemini');
    expect(system).not.toContain('Codex can be consulted'); // Codex is not on the team
    expect(system).toMatch(/cannot change anything/);
  });

  it('offers only the teammates that are on the team, each with the model chosen for it', async () => {
    const claude = stub('claude', 'a');
    const room = new Room({
      adapters: { claude, gemini: stub('gemini', 'b'), codex: stub('codex', 'c') },
      cwd: '/w',
      transcript: new FileTranscript(await tmpFile()),
      peerServer: { entry: '/x/peer-main.js', team: { codex: { model: 'gpt-5.1-codex', effort: 'high' } } },
    });
    await room.turn('claude', 'go', { withPeerTools: true });
    const env = claude.requests[0]!.mcpServers![0]!.env!;
    expect(env.AIO_ROOM_PEERS).toBe('codex');
    expect(JSON.parse(env.AIO_ROOM_TEAM!)).toEqual({ codex: { model: 'gpt-5.1-codex', effort: 'high' } });
  });

  it('with nobody on the team the lead gets no room tools and no team speech', async () => {
    const claude = stub('claude', 'a');
    const room = new Room({
      adapters: { claude, gemini: stub('gemini', 'b') },
      cwd: '/w',
      transcript: new FileTranscript(await tmpFile()),
      peerServer: { entry: '/x/peer-main.js', team: {} },
    });
    await room.turn('claude', 'go', { withPeerTools: true });
    expect(claude.requests[0]!.mcpServers).toBeUndefined();
    expect(claude.requests[0]!.systemPrompt).not.toMatch(/lead of a small team/);
  });

  it('puts the team in the environment of the room server without any secret', () => {
    const spec = peerServerSpec({ self: 'claude', peers: ['gemini'], transcriptFile: '/r', cwd: '/w', entry: '/x/peer-main.js', team: { gemini: { model: 'g-high' } } });
    expect(spec.env!.AIO_ROOM_TEAM).toBe('{"gemini":{"model":"g-high"}}');
    expect(Object.keys(spec.env!).every((k) => k.startsWith('AIO_ROOM_'))).toBe(true);
  });
});

describe('asking a teammate', () => {
  async function connect(team: Record<string, { model?: string; effort?: string }>, adapters: Parameters<typeof createPeerServer>[0]['adapters']) {
    const server = createPeerServer({ self: 'claude', peers: ['gemini', 'codex'], adapters, transcript: new MemoryTranscript(), cwd: '/w', maxAsks: 6, team });
    const [a, b] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'test', version: '0' });
    await Promise.all([server.connect(a), client.connect(b)]);
    return client;
  }

  it('runs the teammate on the model the user picked, read-only, whatever the lead says', async () => {
    const gemini = stub('gemini', 'Looks fine');
    const client = await connect({ gemini: { model: 'gemini-4-argon-high' } }, { gemini });
    const r = (await client.callTool({ name: 'ask_peer', arguments: { peer: 'gemini', question: 'Review this?' } })) as { content: { text: string }[] };
    expect(r.content[0]!.text).toBe('Looks fine');
    expect(gemini.requests[0]).toMatchObject({ model: 'gemini-4-argon-high', access: 'read-only' });
    expect(gemini.requests[0]!.mcpServers).toBeUndefined();
  });

  it('a teammate with no model chosen uses its own default', async () => {
    const codex = stub('codex', 'ok');
    const client = await connect({ codex: {} }, { codex });
    await client.callTool({ name: 'ask_peer', arguments: { peer: 'codex', question: 'Hi?' } });
    expect(codex.requests[0]!.model).toBeUndefined();
  });
});

describe('continuing the lead\'s own session', () => {
  it('sends only what is new since the session\'s last turn, and passes the session on', async () => {
    const claude = stub('claude', 'second answer');
    const room = new Room({ adapters: { claude }, cwd: '/w' });
    await room.say('First question');
    await room.turn('claude', 'Answer.');
    const known = (await room.messages()).length;
    await room.say('Follow-up question');
    await room.turn('claude', 'Answer.', { sessionId: 'sess-1', sinceIndex: known });

    const second = claude.requests[1]!;
    expect(second.sessionId).toBe('sess-1');
    expect(second.prompt).toContain('NEW IN THE ROOM SINCE YOUR LAST TURN');
    expect(second.prompt).toContain('Follow-up question');
    expect(second.prompt).not.toContain('First question');
    // a first turn gets the whole transcript
    expect(claude.requests[0]!.prompt).toContain('ROOM TRANSCRIPT');
    expect(claude.requests[0]!.sessionId).toBeUndefined();
  });

  it('a fallback provider never gets the first provider\'s session', async () => {
    const claude = stub('claude', () => fail('usage limit reached'));
    const codex = stub('codex', 'covered');
    const room = new Room({ adapters: { claude, codex }, cwd: '/w' });
    await room.say('Question');
    await room.turn(['claude', 'codex'], 'Answer.', { sessionId: 'claude-session', sinceIndex: 0, model: 'opus' });
    expect(claude.requests[0]!.sessionId).toBe('claude-session');
    expect(codex.requests[0]!.sessionId).toBeUndefined();
    expect(codex.requests[0]!.prompt).toContain('ROOM TRANSCRIPT');
  });

  it('reports the session the CLI gave, so the caller can keep it', async () => {
    const room = new Room({ adapters: { claude: stub('claude', () => reply('x')) }, cwd: '/w' });
    expect((await room.turn('claude', 'go')).sessionId).toBe('sess');
  });
});
