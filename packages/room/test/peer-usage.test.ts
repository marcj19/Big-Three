import { appendFile, mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { FileTranscript, Room } from '../src/index.js';
import { reply, stub } from './helpers.js';

const dirs: string[] = [];
afterAll(() => Promise.all(dirs.map((d) => rm(d, { recursive: true, force: true }))));

describe('what consulted colleagues spend', () => {
  it('adds the usage the peer server reported to the room, once, after the lead turn', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'aio-peer-usage-'));
    dirs.push(dir);
    const usageFile = path.join(dir, 'consults.jsonl');
    // The lead "consults" Gemini during its turn: the peer server (another process) writes one line for it.
    const codex = stub('codex', async () => { throw new Error('unused'); }, {});
    codex.run = async function* () {
      await appendFile(usageFile, `${JSON.stringify({ peer: 'gemini', status: 'ok', usage: { inputTokens: 13000, outputTokens: 700, costUsd: 0 } })}\n`);
      yield* reply('done', { inputTokens: 20000, outputTokens: 300 });
    };
    const room = new Room({
      adapters: { codex, gemini: stub('gemini', 'x') }, cwd: dir, transcript: new FileTranscript(path.join(dir, 'room.jsonl')),
      peerServer: { usageFile, team: { gemini: {} } },
    });
    await room.say('Coordinate');
    await room.turn('codex', 'Answer', { withPeerTools: true });
    await room.turn('codex', 'Again', { withPeerTools: true });

    const usage = room.usage.snapshot();
    expect(usage.codex).toMatchObject({ turns: 2, inputTokens: 40000, outputTokens: 600 });
    // One consultation per lead turn, each added once: the second turn must not add the first one again.
    expect(usage.gemini).toMatchObject({ turns: 2, inputTokens: 26000, outputTokens: 1400 });
  });
});
