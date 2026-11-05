import { describe, expect, it } from 'vitest';
import type { AppEvent, ProviderStatus, RoomEventView } from '../src/shared/api.js';
import { nextActivities, officeStatus, toolActivity } from '../src/renderer/office-model.js';

const provider: ProviderStatus = { id: 'claude', displayName: 'Claude', available: true, signedIn: true, canLogin: true, supportsMcp: true, efforts: [] };
const room = (event: RoomEventView): AppEvent => ({ type: 'room', runId: 'run', conversationId: 'chat', event });

describe('office visual state', () => {
  it('follows real events independently for each provider', () => {
    let state = nextActivities({}, room({ type: 'turn_start', provider: 'claude', instruction: '' }));
    state = nextActivities(state, room({ type: 'text', provider: 'claude', text: 'hello', partial: true }));
    state = nextActivities(state, room({ type: 'turn_start', provider: 'codex', instruction: '' }));
    expect(state).toEqual({ claude: 'writing', codex: 'thinking' });
    state = nextActivities(state, room({ type: 'tool_call', provider: 'claude', name: 'read_file' }));
    state = nextActivities(state, room({ type: 'turn_end', provider: 'codex', status: 'error', error: 'failed', inputTokens: 0, outputTokens: 0 }));
    expect(state).toEqual({ claude: 'reading', codex: 'error' });
    const done: AppEvent = { type: 'run_done', runId: 'run', conversationId: 'chat', outcome: { status: 'ok', final: '' } };
    expect(nextActivities(state, done)).toEqual({ claude: 'done', codex: 'error' });
  });

  it('ties gestures to observed tools and does not guess unknown tools', () => {
    for (const [name, action] of [['Read', 'reading'], ['fs.read_file', 'reading'], ['apply_patch', 'editing'], ['mcp__fs__Edit', 'editing'],
      ['shell', 'terminal'], ['mcp__db__query', 'database'], ['room.ask_peer', 'consulting'], ['web_search', 'searching'], ['unknown', 'tool']]) {
      expect(toolActivity(name!)).toBe(action);
    }
  });

  it('stops a tool gesture when its actual result arrives', () => {
    const active = nextActivities({}, room({ type: 'tool_call', provider: 'codex', name: 'shell' }));
    expect(active.codex).toBe('terminal');
    expect(nextActivities(active, room({ type: 'tool_result', provider: 'codex', name: 'shell', isError: false })).codex).toBe('thinking');
  });

  it('animates the consulted teammate and the waiting lead without inventing text', () => {
    const state = nextActivities({ claude: 'thinking' }, { type: 'peer_activity', runId: 'r', conversationId: 'c', self: 'claude', peer: 'gemini', activity: 'thinking' });
    expect(state).toEqual({ claude: 'consulting', gemini: 'reviewing' });
    expect(nextActivities(state, { type: 'run_done', runId: 'r', conversationId: 'c', outcome: { status: 'cancelled', final: '' } }))
      .toEqual({ claude: 'cancelled', gemini: 'cancelled' });
  });

  it('stops active characters on cancellation and preserves quota limits', () => {
    const state = nextActivities({ claude: 'thinking' }, room({ type: 'limit', provider: 'gemini', status: 'rejected' }));
    expect(nextActivities(state, { type: 'run_done', runId: 'run', conversationId: 'chat', outcome: { status: 'cancelled', final: '' } }))
      .toEqual({ claude: 'cancelled', gemini: 'limited' });
  });

  it('does not confuse a healthy quota window with a usage limit', () => {
    expect(nextActivities({ claude: 'writing' }, room({ type: 'limit', provider: 'claude', status: 'allowed' })))
      .toEqual({ claude: 'writing' });
  });

  it('does not present unavailable or signed-out models as working', () => {
    expect(officeStatus(undefined, true, 'writing')).toBe('checking');
    expect(officeStatus({ ...provider, available: false }, true, 'writing')).toBe('offline');
    expect(officeStatus({ ...provider, signedIn: false }, true, 'writing')).toBe('signed-out');
    expect(officeStatus(provider, false)).toBe('away');
    expect(officeStatus(provider, true)).toBe('idle');
    // Fallbacks can work even if the provider was not selected as a teammate.
    expect(officeStatus(provider, false, 'writing')).toBe('writing');
  });
});
