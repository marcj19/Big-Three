import { describe, expect, it } from 'vitest';
import { CodexAdapter } from '../src/adapters/codex.js';

class ObservableCodex extends CodexAdapter { parser() { return this.createParser(); } }
describe('Codex file and search activity', () => {
  it('reports completion-only patches without forwarding paths or patch contents', () => {
    const parse = new ObservableCodex().parser();
    expect(parse({ type: 'item.completed', item: { id: 'patch', type: 'file_change', changes: [{ path: 'private.txt', kind: 'update' }], status: 'completed' } }))
      .toEqual([{ type: 'tool_call', name: 'apply_patch' }, { type: 'tool_result', name: 'apply_patch', isError: false }]);
  });
  it('does not duplicate a tool call when both start and completion arrive', () => {
    const parse = new ObservableCodex().parser();
    expect(parse({ type: 'item.started', item: { id: 'patch', type: 'file_change' } })).toEqual([{ type: 'tool_call', name: 'apply_patch' }]);
    expect(parse({ type: 'item.completed', item: { id: 'patch', type: 'file_change', status: 'failed' } }))
      .toEqual([{ type: 'tool_result', name: 'apply_patch', isError: true }]);
    expect(parse({ type: 'item.completed', item: { id: 'search', type: 'web_search', query: 'private question' } }))
      .toEqual([{ type: 'tool_call', name: 'web_search' }, { type: 'tool_result', name: 'web_search' }]);
  });
});
