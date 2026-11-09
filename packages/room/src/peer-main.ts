#!/usr/bin/env node
import { appendFileSync, existsSync } from 'node:fs';
import { assertSafeChoice, createAdapters, type ProviderId } from '@aio/core';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import type { Team } from './peer-launch.js';
import { createPeerServer } from './peer-server.js';
import { FileTranscript } from './transcript.js';
import { fileActivitySink } from './peer-activity.js';

const PROVIDERS: readonly string[] = ['claude', 'gemini', 'codex'];
const isProvider = (v: string | undefined): v is ProviderId => v !== undefined && PROVIDERS.includes(v);

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set`);
  return value;
}

/** The team comes from the app and is checked again here: model names end up on a command line. */
function parseTeam(raw: string | undefined): Team | undefined {
  if (!raw) return undefined;
  const parsed = JSON.parse(raw) as Record<string, { model?: unknown; effort?: unknown } | undefined>;
  const team: Team = {};
  for (const [name, member] of Object.entries(parsed)) {
    if (!isProvider(name)) continue;
    const choice = { model: typeof member?.model === 'string' ? member.model : undefined, effort: typeof member?.effort === 'string' ? member.effort : undefined };
    assertSafeChoice(choice);
    team[name] = choice;
  }
  return team;
}

async function main() {
  const self = process.env.AIO_ROOM_SELF;
  if (!isProvider(self)) throw new Error('AIO_ROOM_SELF must be claude, gemini or codex');
  const peers = required('AIO_ROOM_PEERS').split(',').filter(isProvider);
  if (peers.length === 0) throw new Error('AIO_ROOM_PEERS lists no known provider');

  const team = parseTeam(process.env.AIO_ROOM_TEAM);
  const abort = new AbortController();
  const lease = process.env.AIO_ROOM_LEASE_FILE;
  if (lease) {
    const check = () => { if (!existsSync(lease)) abort.abort(); };
    check();
    const timer = setInterval(check, 100);
    timer.unref();
    abort.signal.addEventListener('abort', () => clearInterval(timer), { once: true });
    if (abort.signal.aborted) clearInterval(timer);
  }
  process.once('SIGTERM', () => abort.abort());
  process.once('SIGINT', () => abort.abort());
  const usageFile = process.env.AIO_ROOM_USAGE_FILE;
  const server = createPeerServer({
    team,
    permissions: process.env.AIO_ROOM_WEB === '1' ? { web: true } : undefined,
    onConsult: usageFile ? ({ peer, result }) => {
      // One small append per consultation; a failure to write must never break the answer the lead is waiting for.
      try { appendFileSync(usageFile, `${JSON.stringify({ peer, status: result.status, usage: result.usage })}\n`); } catch { /* usage is best effort */ }
    } : undefined,
    onActivity: process.env.AIO_ROOM_ACTIVITY_FILE ? fileActivitySink(process.env.AIO_ROOM_ACTIVITY_FILE) : undefined,
    self,
    signal: abort.signal,
    peers,
    adapters: createAdapters(),
    transcript: new FileTranscript(required('AIO_ROOM_FILE')),
    cwd: required('AIO_ROOM_CWD'),
    maxAsks: Math.max(0, Number.parseInt(process.env.AIO_ROOM_MAX_ASKS ?? '6', 10) || 0),
  });
  await server.connect(new StdioServerTransport());
  server.server.onclose = () => abort.abort();
}

// stdout carries the MCP protocol, so diagnostics go to stderr.
main().catch((err) => {
  console.error('aio-room-peer failed to start:', err instanceof Error ? err.message : err);
  process.exit(1);
});
