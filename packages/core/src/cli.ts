#!/usr/bin/env node
/** Developer tool: `aio detect` or `aio run <claude|gemini|codex> [--access read-only|edit|full] [--cwd dir] "prompt"`. */
import { createAdapters, type Access, type ProviderId } from './index.js';

const rawMode = process.argv.includes('--raw');
const adapters = createAdapters(
  rawMode
    ? Object.fromEntries((['claude', 'gemini', 'codex'] as const).map((p) => [p, { onRawLine: (l: string) => console.error('RAW', l) }]))
    : {},
);
const [cmd, ...rest] = process.argv.slice(2).filter((a) => a !== '--raw');

async function detect() {
  for (const a of Object.values(adapters)) {
    const r = await a.detect();
    if (!r.available) {
      console.log(`${a.displayName.padEnd(7)} --  ${r.reason}`);
      continue;
    }
    const auth = await a.authStatus();
    console.log(`${a.displayName.padEnd(7)} ok  ${r.version ?? ''}  signed in: ${auth.signedIn}${auth.detail ? ` (${auth.detail})` : ''}`);
  }
}

async function login(provider: string | undefined) {
  const adapter = adapters[provider as ProviderId];
  if (!adapter) throw new Error('Usage: login <claude|gemini|codex>');
  const ac = new AbortController();
  process.on('SIGINT', () => ac.abort());
  for await (const ev of adapter.login(ac.signal)) {
    if (ev.type === 'output') console.log(ev.line);
    else console.log(ev.ok ? 'Signed in.' : `Not signed in: ${ev.message}`);
  }
}

async function run(args: string[]) {
  const [provider, ...more] = args;
  const adapter = adapters[provider as ProviderId];
  if (!adapter) throw new Error('Usage: run <claude|gemini|codex> [--access ...] [--cwd dir] "prompt"');
  let access: Access = 'read-only';
  let cwd = process.cwd();
  const words: string[] = [];
  for (let i = 0; i < more.length; i++) {
    if (more[i] === '--access') access = more[++i] as Access;
    else if (more[i] === '--cwd') cwd = more[++i]!;
    else words.push(more[i]!);
  }
  const ac = new AbortController();
  process.on('SIGINT', () => ac.abort());
  for await (const ev of adapter.run({ prompt: words.join(' '), cwd, access, signal: ac.signal, timeoutMs: 300_000 })) {
    if (ev.type === 'text') console.log(ev.text);
    else console.error(`[${ev.type}]`, JSON.stringify({ ...ev, type: undefined }));
  }
}

(cmd === 'detect'
  ? detect()
  : cmd === 'run'
    ? run(rest)
    : cmd === 'login'
      ? login(rest[0])
      : Promise.reject(new Error('Usage: detect | login <provider> | run ...'))
).catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
