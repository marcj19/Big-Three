import type { AccountQuota } from '../shared/api.js';

type QuotaWindowView = AccountQuota['windows'][number];

const WINDOW_NAMES: Record<string, string> = { five_hour: 'Janela de 5 horas', seven_day: 'Semanal', seven_day_opus: 'Semanal · Opus', seven_day_sonnet: 'Semanal · Sonnet', overage: 'Uso extra' };

/** Narrow-column versions for the sidebar. */
const SHORT_NAMES: Record<string, string> = { five_hour: '5 horas', seven_day: 'Semanal' };

/** Friendly name of a limit window as a CLI reports it ("five_hour", "codex · 5 horas"). */
export function windowLabel(name: string): string {
  return WINDOW_NAMES[name] ?? name.replace(/^codex\s·\s/i, '');
}

/** "hoje às 21:20", "amanhã às 08:00" or "07/11 às 14:00": short enough for the sidebar. */
export function resetText(at: number, now = Date.now()): string {
  const day = new Date(at), today = new Date(now), tomorrow = new Date(now);
  tomorrow.setDate(today.getDate() + 1);
  const time = day.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
  if (day.toDateString() === today.toDateString()) return `hoje às ${time}`;
  if (day.toDateString() === tomorrow.toDateString()) return `amanhã às ${time}`;
  return `${day.toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' })} às ${time}`;
}

export interface Meter {
  label: string;
  /** Only when the CLI or the account reported one and the window has not already rolled over. */
  percent?: number;
  text: string;
  reset: string;
  high: boolean;
}

/** What the sidebar shows for one window. Never invents a percentage: no data means no bar. */
export function meterOf(window: QuotaWindowView, now = Date.now()): Meter {
  const expired = window.resetsAt !== undefined && window.resetsAt <= now;
  const percent = expired || window.usedPercent === undefined ? undefined : Math.min(100, Math.max(0, window.usedPercent));
  const text = percent !== undefined ? `${Math.round(percent)}% usado`
    : expired ? 'renovado, aguardando leitura'
      : window.status === 'rejected' ? 'limite atingido'
        : window.status === 'allowed_warning' ? 'perto do limite'
          : window.status === 'allowed' ? 'dentro do limite' : 'sem percentual';
  return {
    label: SHORT_NAMES[window.name] ?? windowLabel(window.name),
    percent,
    text,
    reset: window.resetsAt === undefined ? '' : `${expired ? 'renovou' : 'renova'} ${resetText(window.resetsAt, now)}`,
    high: (percent ?? 0) >= 90 || window.status === 'rejected',
  };
}
