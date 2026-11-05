import { appendFileSync } from 'node:fs';
import type { AgentErrorCode, ProviderId } from '@aio/core';
import type { RoomEvent } from './types.js';

export interface PeerActivity {
  self: ProviderId;
  peer: ProviderId;
  activity: 'thinking' | 'writing' | 'tool' | 'done' | 'error' | 'cancelled';
  tool?: string;
  failure?: AgentErrorCode | 'usage-limit';
}
/** Only small visual metadata crosses this journal: no prompts, outputs, paths, or tool arguments. */
export function peerActivityReporter(self: ProviderId, emit: (event: PeerActivity) => void): (event: RoomEvent) => void {
  const previous = new Map<ProviderId, string>();
  return (event) => {
    if (event.type === 'skipped' || event.type === 'limit' || event.type === 'subagent' || event.type === 'preview') return;
    const peer = event.type === 'turn_end' ? event.result.provider : event.provider;
    const activity: PeerActivity['activity'] = event.type === 'turn_start' || event.type === 'tool_result' ? 'thinking' : event.type === 'text' ? 'writing'
      : event.type === 'tool_call' ? 'tool' : event.result.status === 'ok' ? 'done' : event.result.status;
    const tool = event.type === 'tool_call' ? event.name.slice(0, 160) : undefined;
    const failure = event.type === 'turn_end' && event.result.status === 'error'
      ? event.result.rateLimited ? 'usage-limit' : event.result.errorCode : undefined;
    const key = `${activity}:${tool ?? ''}:${failure ?? ''}`;
    if (previous.get(peer) === key) return;
    previous.set(peer, key);
    try { emit({ self, peer, activity, ...(tool ? { tool } : {}), ...(failure ? { failure } : {}) }); } catch { /* Cosmetics must never interrupt a model. */ }
  };
}
export function fileActivitySink(file: string): (event: PeerActivity) => void {
  let count = 0;
  return (event) => { if (count++ < 2000) appendFileSync(file, `${JSON.stringify(event)}\n`, { encoding: 'utf8', mode: 0o600 }); };
}
