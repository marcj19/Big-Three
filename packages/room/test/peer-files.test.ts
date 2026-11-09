import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterAll, describe, expect, it } from 'vitest';
import { createPeerServer, MemoryTranscript } from '../src/index.js';
import { inlineFiles, MAX_FILE_BYTES } from '../src/peer-files.js';
import { stub } from './helpers.js';

const dirs: string[] = [];
afterAll(() => Promise.all(dirs.map((d) => rm(d, { recursive: true, force: true }))));
async function project() {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'aio-files-'));
  dirs.push(dir);
  await mkdir(path.join(dir, 'src'));
  await writeFile(path.join(dir, 'src', 'a.js'), 'const a = 1;\nmodule.exports = a;\n');
  await writeFile(path.join(dir, '.env'), 'TOKEN=abc');
  await writeFile(path.join(dir, 'blob.bin'), Buffer.from([1, 2, 0, 3]));
  await writeFile(path.join(dir, 'big.txt'), 'x'.repeat(MAX_FILE_BYTES + 500));
  return dir;
}

describe('files sent with a question', () => {
  it('includes the file with line numbers, relative to the project', async () => {
    const dir = await project();
    const r = await inlineFiles(dir, ['src/a.js']);
    expect(r.included).toEqual(['src/a.js']);
    expect(r.text).toContain('--- src/a.js ---');
    expect(r.text).toContain('   1| const a = 1;');
    expect(r.skipped).toEqual([]);
  });

  it('refuses secrets, other folders, binaries and missing files, and says why', async () => {
    const dir = await project();
    const outside = path.join(os.tmpdir(), 'aio-outside.txt');
    await writeFile(outside, 'private');
    dirs.push(outside);
    const r = await inlineFiles(dir, ['.env', '../aio-outside.txt', outside, 'blob.bin', 'nope.js']);
    expect(r.included).toEqual([]);
    expect(r.text).toBe('');
    expect(r.skipped.join('\n')).toMatch(/\.env: looks like a secrets file/);
    expect(r.skipped.join('\n')).toMatch(/aio-outside\.txt: outside the project folder/);
    expect(r.skipped.join('\n')).toMatch(/blob\.bin: binary file/);
    expect(r.skipped.join('\n')).toMatch(/nope\.js: not found/);
  });

  it('does not follow a link out of the project', async () => {
    const dir = await project();
    const outside = path.join(os.tmpdir(), `aio-outside-${Date.now()}.txt`);
    await writeFile(outside, 'private');
    dirs.push(outside);
    try { await symlink(outside, path.join(dir, 'link.txt')); } catch { return; } // links may need extra rights on Windows
    expect((await inlineFiles(dir, ['link.txt'])).included).toEqual([]);
  });

  it('cuts a very large file and caps how many are sent', async () => {
    const dir = await project();
    const r = await inlineFiles(dir, ['big.txt']);
    expect(r.included).toEqual(['big.txt']);
    expect(r.text).toContain('cut at');
    const many = await inlineFiles(dir, ['src/a.js', 'src/a.js', 'big.txt', 'big.txt', 'src/a.js', 'src/a.js', 'src/a.js', 'src/a.js']);
    expect(many.included.length).toBeLessThanOrEqual(2); // duplicates collapse
  });

  it('ask_peer gives the colleague the file in the question but keeps it out of the shared transcript', async () => {
    const dir = await project();
    const gemini = stub('gemini', 'Looks fine.');
    const transcript = new MemoryTranscript();
    const server = createPeerServer({ self: 'claude', peers: ['gemini'], adapters: { gemini }, transcript, cwd: dir, maxAsks: 2 });
    const [a, b] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'test', version: '0' });
    await Promise.all([server.connect(a), client.connect(b)]);
    const r = await client.callTool({ name: 'ask_peer', arguments: { peer: 'gemini', question: 'Review it', files: ['src/a.js', '.env'] } }) as { content: { text: string }[] };

    expect(gemini.requests[0]!.prompt).toContain('const a = 1;');
    expect(gemini.requests[0]!.prompt).not.toContain('TOKEN=abc');
    expect(r.content[0]!.text).toContain('Looks fine.');
    expect(r.content[0]!.text).toContain('.env: looks like a secrets file');
    expect((await transcript.list()).map((m) => m.text).join('\n')).not.toContain('const a = 1;');
    await client.close();
  });
});
