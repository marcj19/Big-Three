import type { ResolvedCommand } from './command.js';
import type { QuotaWindow } from './types.js';
import { isRecord, num, str } from './adapters/base.js';
import { readCodexAppServer } from './codex-app-server.js';

/** Official account/rateLimits/read response; never infer a subscription budget from token counts. */
export function parseCodexQuota(raw: unknown): QuotaWindow[] {
  if (!isRecord(raw)) return [];
  const buckets = isRecord(raw.rateLimitsByLimitId) && Object.keys(raw.rateLimitsByLimitId).length
    ? Object.entries(raw.rateLimitsByLimitId) : [['codex', raw.rateLimits]];
  const windows: QuotaWindow[] = [];
  for (const [id, value] of buckets) {
    if (!isRecord(value)) continue;
    for (const key of ['primary', 'secondary']) {
      const window = value[key];
      if (!isRecord(window)) continue;
      const usedPercent = num(window.usedPercent), minutes = num(window.windowDurationMins), reset = num(window.resetsAt);
      if (usedPercent === undefined || usedPercent < 0 || usedPercent > 100) continue;
      const duration = minutes === 10080 ? 'Semanal' : minutes && minutes % 60 === 0 ? `${minutes / 60} horas` : minutes ? `${minutes} minutos` : key === 'primary' ? 'Principal' : 'Secundária';
      windows.push({ name: `${str(value.limitName) ?? id} · ${duration}`, usedPercent,
        resetsAt: reset !== undefined && reset > 0 ? reset * 1000 : undefined, status: usedPercent >= 100 ? 'rejected' : 'allowed' });
    }
  }
  return windows;
}

export async function readCodexQuota(command: ResolvedCommand, env: NodeJS.ProcessEnv, timeoutMs?: number): Promise<QuotaWindow[]> {
  const [quota] = await readCodexAppServer(command, env, 'account/rateLimits/read', timeoutMs);
  return parseCodexQuota(quota);
}
