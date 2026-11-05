import { expect, it, vi } from 'vitest';
import { buildSpec, loadConfig, saveConfig, state } from '../src/renderer/state.js';

it('restores the configured team and uses the saved choices when building a task', () => {
  const saved = new Map<string, string>();
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => saved.get(key) ?? null,
    setItem: (key: string, value: string) => saved.set(key, value),
  });
  const original = structuredClone(state.config);
  const originalProviders = state.providers;
  try {
    state.config.team.gemini = { enabled: true, model: 'gemini-3.8-flash-low' };
    state.config.team.codex = { enabled: true, model: 'gpt-example', effort: 'high', customModel: true };
    state.config.consultTeam = true;
    saveConfig();

    state.config = structuredClone(original);
    loadConfig();
    state.providers = (['claude', 'gemini', 'codex'] as const).map((id) => ({
      id, displayName: id, available: true, signedIn: true, canLogin: false, supportsMcp: id !== 'gemini', efforts: [],
    }));

    expect(state.config.team.codex.customModel).toBe(true);
    expect(buildSpec(state.config)).toMatchObject({ kind: 'lead', consultTeam: true, team: [
      { provider: 'gemini', model: 'gemini-3.8-flash-low' },
      { provider: 'codex', model: 'gpt-example', effort: 'high' },
    ] });
  } finally {
    state.config = original;
    state.providers = originalProviders;
    vi.unstubAllGlobals();
  }
});
