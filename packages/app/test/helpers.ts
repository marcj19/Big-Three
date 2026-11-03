import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { Adapter, AgentEvent, ProviderId, RunRequest } from '@aio/core';
import { KeyringSecretStore, type EntryFactory } from '@aio/db-broker';
import { afterAll } from 'vitest';
import { AppService, type AppServiceOptions } from '../src/services/app-service.js';
import type { AppEvent } from '../src/shared/api.js';

const dirs: string[] = [];
afterAll(() => Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true }))));

export async function tmp(prefix = 'aio-app-test-'): Promise<string> {
  const d = await mkdtemp(path.join(os.tmpdir(), prefix));
  dirs.push(d);
  return d;
}

/** A vault that lives in memory, keyed like the real one. */
export function memoryVault() {
  const data = new Map<string, string>();
  const factory: EntryFactory = (service, account) => {
    const key = `${service}\u0000${account}`;
    return { getPassword: () => data.get(key) ?? null, setPassword: (p) => void data.set(key, p), deletePassword: () => data.delete(key) };
  };
  return { data, store: new KeyringSecretStore({ entryFactory: factory }) };
}

export interface StubAdapter extends Adapter {
  requests: RunRequest[];
}

export function stub(id: ProviderId, text: string | ((req: RunRequest) => AgentEvent[]), opts: { mcp?: boolean; delayMs?: number } = {}): StubAdapter {
  const requests: RunRequest[] = [];
  return {
    id,
    displayName: id.toUpperCase(),
    supportsResume: false,
    supportsMcp: opts.mcp ?? true,
    efforts: [],
    listModels: async () => [{ id: '', label: 'Padrão da conta' }],
    canLogin: true,
    requests,
    detect: async () => ({ available: true, version: '1.0' }),
    authStatus: async () => ({ signedIn: true }),
    async *login() {
      yield { type: 'output', line: 'open browser' };
      yield { type: 'done', ok: true };
    },
    async *run(req) {
      requests.push(req);
      if (opts.delayMs) {
        for (let waited = 0; waited < opts.delayMs; waited += 10) {
          if (req.signal?.aborted) break;
          await new Promise((r) => setTimeout(r, 10));
        }
      }
      if (req.signal?.aborted) {
        yield { type: 'done', status: 'cancelled' };
        return;
      }
      if (typeof text === 'function') yield* text(req);
      else yield* [{ type: 'usage' as const, inputTokens: 3, outputTokens: 2 }, { type: 'done' as const, status: 'ok' as const, text }];
    },
  };
}

export async function makeApp(overrides: Partial<AppServiceOptions> & { adapters?: Partial<Record<ProviderId, StubAdapter>> } = {}) {
  const configDir = await tmp();
  const workdir = await tmp('aio-app-work-');
  const events: AppEvent[] = [];
  const vault = memoryVault();
  const app = new AppService({
    configDir,
    vault: vault.store,
    emit: (e) => events.push(e),
    brokerEntry: '/x/server.js',
    peerEntry: '/x/peer-main.js',
    ...overrides,
  });
  const done = (conversationId: string) =>
    new Promise<Extract<AppEvent, { type: 'run_done' }>>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('run did not finish')), 10_000);
      const poll = setInterval(() => {
        const e = events.find((x) => x.type === 'run_done' && x.conversationId === conversationId);
        if (e) {
          clearTimeout(timer);
          clearInterval(poll);
          resolve(e as Extract<AppEvent, { type: 'run_done' }>);
        }
      }, 5);
    });
  return { app, configDir, workdir, events, vault, done };
}
