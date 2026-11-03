import type { ProviderId } from '@aio/core';
import type { TurnResult } from './types.js';

/** CLIs word subscription limits differently; this is deliberately broad because a false positive only triggers a fallback. */
const LIMIT_MESSAGE = /rate.?limit|usage limit|quota|too many requests|\b429\b|resource.?exhausted|limit (reached|exceeded)|try again (later|in)/i;

export function looksRateLimited(message: string | undefined): boolean {
  return message !== undefined && LIMIT_MESSAGE.test(message);
}

export interface ProviderUsage {
  turns: number;
  failures: number;
  inputTokens: number;
  outputTokens: number;
  /** Notional for subscriptions (nothing is billed per token); useful as a relative measure. */
  costUsd: number;
  /** Skip this provider until then, after a limit error. */
  limitedUntil?: number;
  /** The last limit window the CLI reported (Claude announces its five-hour window on every run). */
  window?: { status: string; name?: string; resetsAt?: number };
}

const COOLDOWN_MS = 15 * 60_000;

export class UsageTracker {
  private readonly byProvider = new Map<ProviderId, ProviderUsage>();

  constructor(private readonly now: () => number = Date.now, private readonly cooldownMs = COOLDOWN_MS) {}

  private entry(provider: ProviderId): ProviderUsage {
    let e = this.byProvider.get(provider);
    if (!e) {
      e = { turns: 0, failures: 0, inputTokens: 0, outputTokens: 0, costUsd: 0 };
      this.byProvider.set(provider, e);
    }
    return e;
  }

  record(result: TurnResult): void {
    if (result.status === 'cancelled') return;
    const e = this.entry(result.provider);
    e.turns++;
    e.inputTokens += result.usage.inputTokens;
    e.outputTokens += result.usage.outputTokens;
    e.costUsd += result.usage.costUsd;
    if (result.status === 'error') e.failures++;
    if (result.rateLimited) e.limitedUntil = this.now() + this.cooldownMs;
    else if (result.status === 'ok') delete e.limitedUntil;
  }

  /**
   * Remembers what a CLI said about its limit window. Only `allowed` has been seen live; a `rejected` status
   * (the Claude Agent SDK's name for being out of quota) pauses the provider until the reported reset.
   */
  noteWindow(provider: ProviderId, window: { status: string; name?: string; resetsAt?: number }): void {
    const e = this.entry(provider);
    e.window = window;
    if (window.status === 'rejected' && window.resetsAt !== undefined) e.limitedUntil = window.resetsAt;
  }

  /** Marks a provider as limited until `until` (epoch ms), e.g. from the reset time a CLI reported. */
  markLimited(provider: ProviderId, until: number): void {
    this.entry(provider).limitedUntil = until;
  }

  isLimited(provider: ProviderId): boolean {
    const until = this.byProvider.get(provider)?.limitedUntil;
    return until !== undefined && until > this.now();
  }

  snapshot(): Record<string, ProviderUsage> {
    return Object.fromEntries([...this.byProvider].map(([k, v]) => [k, { ...v }]));
  }
}
