import { describe, expect, it } from 'vitest';
import { peerActivityReporter, type PeerActivity } from '../src/peer-activity.js';

describe('peer activity metadata', () => {
  it('deduplicates text deltas and never sends prompts or response contents to the journal', () => {
    const events: PeerActivity[] = [];
    const report = peerActivityReporter('claude', (event) => events.push(event));
    report({ type: 'turn_start', provider: 'gemini', instruction: 'private task' });
    for (let i = 0; i < 50; i++) report({ type: 'text', provider: 'gemini', text: 'private output', partial: true });
    report({ type: 'tool_call', provider: 'gemini', name: 'read_file' });
    report({ type: 'turn_end', result: { provider: 'gemini', status: 'ok', text: 'private answer', usage: { inputTokens: 0, outputTokens: 0, costUsd: 0 }, rateLimited: false } });
    expect(events.map((event) => event.activity)).toEqual(['thinking', 'writing', 'tool', 'done']);
    expect(JSON.stringify(events)).not.toContain('private');
  });
  it('continues a model turn even if cosmetic reporting fails', () => {
    const report = peerActivityReporter('claude', () => { throw new Error('disk unavailable'); });
    expect(() => report({ type: 'turn_start', provider: 'gemini', instruction: '' })).not.toThrow();
  });
});
