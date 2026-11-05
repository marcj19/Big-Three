import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parseCodexQuota, readCodexQuota } from '../src/codex-quota.js';
import { sanitizeEnv } from '../src/env.js';
import { ClaudeAdapter } from '../src/adapters/claude.js';

const fixture = fileURLToPath(new URL('./fixtures/quota-server.mjs', import.meta.url));
describe('Codex account quotas', () => {
  it('reads all metered buckets once, preserves zero and rejects invalid percentages', () => {
    expect(parseCodexQuota({ rateLimits: { primary: { usedPercent: 99 } }, rateLimitsByLimitId: {
      codex: { primary: { usedPercent: 0, windowDurationMins: 300, resetsAt: 1900000000 }, secondary: { usedPercent: 100, windowDurationMins: 10080 } },
      review: { limitName: 'Review', primary: { usedPercent: 30, windowDurationMins: 15 } }, invalid: { primary: { usedPercent: -1 }, secondary: { usedPercent: '80' } },
    } })).toEqual([
      { name: 'codex · 5 horas', usedPercent: 0, resetsAt: 1900000000000, status: 'allowed' },
      { name: 'codex · Semanal', usedPercent: 100, resetsAt: undefined, status: 'rejected' },
      { name: 'Review · 15 minutos', usedPercent: 30, resetsAt: undefined, status: 'allowed' },
    ]);
    expect(parseCodexQuota(null)).toEqual([]);
  });
  it('completes the handshake and reads quotas without creating a thread or starting a turn', async () => {
    const quotas = await readCodexQuota({ file: process.execPath, prefixArgs: [fixture, 'ok'] }, sanitizeEnv(process.env));
    expect(quotas).toHaveLength(2);
    expect(quotas[0]).toMatchObject({ usedPercent: 25, resetsAt: 1900000000000 });
  });
  it('bounds stalled checks and sanitizes server errors', async () => {
    const command = (mode: string) => ({ file: process.execPath, prefixArgs: [fixture, mode] });
    await expect(readCodexQuota(command('error'), sanitizeEnv(process.env))).rejects.toThrow('Account quota unavailable');
    await expect(readCodexQuota(command('timeout'), sanitizeEnv(process.env), 150)).rejects.toThrow('timed out');
  });
});

describe('Claude observed quota', () => {
  it('converts reported utilization to percent without inventing missing values', () => {
    class InspectClaude extends ClaudeAdapter { parse(raw: unknown) { return this.createParser()(raw); } }
    const adapter = new InspectClaude();
    expect(adapter.parse({ type: 'rate_limit_event', rate_limit_info: { status: 'allowed_warning', rateLimitType: 'five_hour', utilization: 0.85, resetsAt: 1900000000 } }))
      .toEqual([{ type: 'limit', status: 'allowed_warning', window: 'five_hour', usedPercent: 85, resetsAt: 1900000000000 }]);
    for (const utilization of [undefined, NaN, -1, 85]) {
      expect(adapter.parse({ type: 'rate_limit_event', rate_limit_info: { status: 'allowed', utilization } })[0]).not.toHaveProperty('usedPercent');
    }
  });
});
