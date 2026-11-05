import { describe, expect, it } from 'vitest';
import { AppService } from '../src/services/app-service.js';
import { memoryVault, stub, tmp } from './helpers.js';

describe('account quota presentation', () => {
  it('coalesces account reads, preserves real windows and keeps local tokens separate', async () => {
    const codex = stub('codex', 'ok'); let checks = 0;
    codex.readQuota = async () => { checks++; return [{ name: '5 horas', usedPercent: 42, resetsAt: Date.now() + 3600000 }]; };
    const app = new AppService({ configDir: await tmp(), adapters: { codex }, vault: memoryVault().store });
    const [a, b] = await Promise.all([app.accountQuotas(), app.accountQuotas()]);
    expect(checks).toBe(1); expect(a).toEqual(b);
    expect(a.find((quota) => quota.provider === 'codex')).toMatchObject({ source: 'account', windows: [{ usedPercent: 42 }] });
    expect(await app.usage()).toEqual({});
    await app.accountQuotas(); expect(checks).toBe(1);
  });
  it('updates observed windows inside the cache, and never invents missing percentages', async () => {
    const app = new AppService({ configDir: await tmp(), adapters: {}, vault: memoryVault().store });
    await app.accountQuotas();
    app.usageTracker.noteWindow('claude', { name: 'five_hour', status: 'allowed', resetsAt: Date.now() + 3600000 });
    app.usageTracker.noteWindow('claude', { name: 'seven_day', status: 'allowed_warning', usedPercent: 85 });
    const quota = (await app.accountQuotas()).find((entry) => entry.provider === 'claude');
    expect(quota).toMatchObject({ source: 'events', windows: [{ name: 'five_hour' }, { name: 'seven_day', usedPercent: 85 }] });
    expect(quota!.windows[0]!.usedPercent).toBeUndefined();
    expect((await app.accountQuotas()).find((entry) => entry.provider === 'gemini')).toMatchObject({ source: 'unavailable', windows: [] });
  });
  it('keeps a failed account query isolated and never exposes raw CLI errors', async () => {
    const codex = stub('codex', 'ok'); codex.readQuota = async () => { throw new Error('secret'); };
    const app = new AppService({ configDir: await tmp(), adapters: { codex }, vault: memoryVault().store });
    const quotas = await app.accountQuotas();
    expect(quotas).toHaveLength(3); expect(JSON.stringify(quotas)).not.toContain('secret');
    expect(quotas.find((quota) => quota.provider === 'codex')).toMatchObject({ source: 'unavailable' });
  });
});
