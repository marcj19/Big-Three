import type { Adapter, AgentEvent, ProviderId, RunRequest } from '@aio/core';

export type Script = (req: RunRequest, call: number) => AgentEvent[] | Error;

export interface StubAdapter extends Adapter {
  requests: RunRequest[];
}

/** Answers with a plain ok run unless the script says otherwise. */
export const reply = (text: string, usage = { inputTokens: 10, outputTokens: 5 }): AgentEvent[] => [
  { type: 'session', sessionId: 'sess' },
  { type: 'text', text },
  { type: 'usage', ...usage },
  { type: 'done', status: 'ok', text },
];

export const fail = (message: string): AgentEvent[] => [
  { type: 'error', message },
  { type: 'done', status: 'error' },
];

export function stub(id: ProviderId, script: Script | string, options: { supportsMcp?: boolean; delayMs?: number } = {}): StubAdapter {
  const requests: RunRequest[] = [];
  const fn: Script = typeof script === 'string' ? () => reply(script) : script;
  return {
    id,
    displayName: id,
    supportsResume: false,
    supportsMcp: options.supportsMcp ?? true,
    efforts: [],
    listModels: async () => [{ id: '', label: 'Padrão da conta' }],
    canLogin: false,
    requests,
    detect: async () => ({ available: true }),
    authStatus: async () => ({ signedIn: true }),
    async *login() {
      yield { type: 'done', ok: true };
    },
    async *run(req: RunRequest) {
      requests.push(req);
      if (options.delayMs) await new Promise((r) => setTimeout(r, options.delayMs));
      if (req.signal?.aborted) {
        yield { type: 'done', status: 'cancelled' };
        return;
      }
      const out = fn(req, requests.length);
      if (out instanceof Error) throw out;
      yield* out;
    },
  };
}
