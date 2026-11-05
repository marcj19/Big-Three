import { describe, expect, it } from 'vitest';
import { meterOf, resetText, windowLabel } from '../src/renderer/quota-format.js';

const now = new Date(2026, 10, 4, 12, 0).getTime();

describe('sidebar quota meters', () => {
  it('names windows the way people say them', () => {
    expect(windowLabel('five_hour')).toBe('Janela de 5 horas');
    expect(windowLabel('seven_day_opus')).toBe('Semanal · Opus');
    expect(windowLabel('codex · 5 horas')).toBe('5 horas');
    expect(windowLabel('algo novo')).toBe('algo novo');
  });

  it('says when the window renews, in short form', () => {
    expect(resetText(new Date(2026, 10, 4, 21, 20).getTime(), now)).toBe('hoje às 21:20');
    expect(resetText(new Date(2026, 10, 5, 8, 0).getTime(), now)).toBe('amanhã às 08:00');
    expect(resetText(new Date(2026, 10, 7, 14, 0).getTime(), now)).toBe('07/11 às 14:00');
  });

  it('shows the percentage only when one was reported', () => {
    const reset = new Date(2026, 10, 7, 14, 0).getTime();
    expect(meterOf({ name: 'seven_day', usedPercent: 89.4, resetsAt: reset }, now)).toMatchObject({ label: 'Semanal', percent: 89.4, text: '89% usado', reset: 'renova 07/11 às 14:00', high: false });
    expect(meterOf({ name: 'seven_day', usedPercent: 95, resetsAt: reset }, now).high).toBe(true);
    const unknown = meterOf({ name: 'five_hour', status: 'allowed', resetsAt: reset }, now);
    expect(unknown.percent).toBeUndefined();
    expect(unknown.text).toBe('dentro do limite');
  });

  it('does not keep showing a percentage after the window rolled over', () => {
    const meter = meterOf({ name: 'five_hour', usedPercent: 98, resetsAt: now - 60_000 }, now);
    expect(meter.percent).toBeUndefined();
    expect(meter.text).toBe('renovado, aguardando leitura');
    expect(meter.high).toBe(false);
  });

  it('flags a rejected window and clamps nonsense values', () => {
    expect(meterOf({ name: 'five_hour', status: 'rejected' }, now)).toMatchObject({ text: 'limite atingido', high: true });
    expect(meterOf({ name: 'x', usedPercent: 140 }, now).percent).toBe(100);
  });
});
