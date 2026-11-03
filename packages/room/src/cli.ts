#!/usr/bin/env node
/**
 * Developer tool for the room:
 *   review <author> <reviewer> "task"
 *   debate <a,b[,c]> "question"
 *   plan <planner> <executor> <reviewer|-> "task" --access read-only|edit|full
 * Common flags: --cwd dir, --peer-tools (give models the ask_peer tools), --raw (print each CLI's raw stdout lines).
 */
import os from 'node:os';
import path from 'node:path';
import { createAdapters, type Access, type ProviderId } from '@aio/core';
import { crossReview, debate, FileTranscript, planExecute, Room, type PatternResult, type RoomEvent } from './index.js';

const PROVIDERS: readonly string[] = ['claude', 'gemini', 'codex'];
const asProvider = (v: string | undefined): ProviderId => {
  if (!v || !PROVIDERS.includes(v)) throw new Error(`Expected claude, gemini or codex, got "${v ?? ''}"`);
  return v as ProviderId;
};

function parseArgs(argv: string[]) {
  const positional: string[] = [];
  const flags = { cwd: process.cwd(), access: undefined as Access | undefined, peerTools: false, raw: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === '--cwd') flags.cwd = argv[++i] ?? flags.cwd;
    else if (a === '--access') flags.access = argv[++i] as Access;
    else if (a === '--peer-tools') flags.peerTools = true;
    else if (a === '--raw') flags.raw = true;
    else positional.push(a);
  }
  return { positional, flags };
}

function show(e: RoomEvent) {
  if (e.type === 'turn_start') console.error(`\n== ${e.provider} ==`);
  else if (e.type === 'tool_call') console.error(`  [tool] ${e.name}`);
  else if (e.type === 'skipped') console.error(`  [skipped ${e.provider}] ${e.reason}`);
  else if (e.type === 'turn_end') {
    const u = e.result.usage;
    console.error(`  [${e.result.status}] in=${u.inputTokens} out=${u.outputTokens}${e.result.error ? ` error=${e.result.error}` : ''}`);
  }
}

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  const { positional, flags } = parseArgs(rest);
  const adapters = createAdapters(
    flags.raw ? Object.fromEntries(PROVIDERS.map((p) => [p, { onRawLine: (l: string) => console.error('RAW', l) }])) : {},
  );
  const file = path.join(os.tmpdir(), `aio-room-${Date.now()}.jsonl`);
  const room = new Room({
    adapters,
    cwd: flags.cwd,
    transcript: new FileTranscript(file),
    onEvent: show,
    peerServer: flags.peerTools ? {} : undefined,
  });
  const ac = new AbortController();
  process.on('SIGINT', () => ac.abort());
  const common = { cwd: flags.cwd, signal: ac.signal, timeoutMs: 300_000, withPeerTools: flags.peerTools };

  let result: PatternResult;
  if (cmd === 'review') {
    result = await crossReview(room, { task: positional[2] ?? '', author: asProvider(positional[0]), reviewer: asProvider(positional[1]), ...common });
  } else if (cmd === 'debate') {
    result = await debate(room, { question: positional[1] ?? '', participants: (positional[0] ?? '').split(',').map(asProvider), ...common });
  } else if (cmd === 'plan') {
    if (!flags.access) throw new Error('plan needs --access read-only|edit|full: say explicitly what the executor may do');
    const reviewer = positional[2] === '-' ? undefined : asProvider(positional[2]);
    result = await planExecute(room, {
      task: positional[3] ?? '',
      planner: asProvider(positional[0]),
      executor: asProvider(positional[1]),
      executorAccess: flags.access,
      reviewer,
      ...common,
    });
  } else {
    throw new Error('Usage: review <author> <reviewer> "task" | debate <a,b> "question" | plan <planner> <executor> <reviewer|-> "task" --access ...');
  }

  console.error(`\nroom file: ${file}`);
  console.error(`usage: ${JSON.stringify(room.usage.snapshot())}`);
  if (result.status !== 'ok') throw new Error(result.status === 'cancelled' ? 'Cancelled' : (result.error ?? 'Failed'));
  console.log(`\n${result.final}`);
  if (result.verdict) console.error(`verdict: ${result.verdict}`);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
