import { ClaudeAdapter } from './adapters/claude.js';
import { CodexAdapter } from './adapters/codex.js';
import { GeminiAdapter } from './adapters/gemini.js';
import type { AdapterOptions } from './adapters/base.js';
import type { Adapter, ProviderId } from './types.js';

export * from './types.js';
export { sanitizeEnv } from './env.js';
export { resolveCommand, type ResolvedCommand } from './command.js';
export { ClaudeAdapter, CodexAdapter, GeminiAdapter };
export type { AdapterOptions } from './adapters/base.js';
export { assertSafeChoice, DEFAULT_MODEL } from './adapters/base.js';
export { parseAgyModels } from './adapters/gemini.js';

export function createAdapters(options: Partial<Record<ProviderId, AdapterOptions>> = {}): Record<ProviderId, Adapter> {
  return {
    claude: new ClaudeAdapter(options.claude),
    gemini: new GeminiAdapter(options.gemini),
    codex: new CodexAdapter(options.codex),
  };
}
