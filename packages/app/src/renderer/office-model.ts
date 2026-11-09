import type { AppEvent, ProviderId, ProviderStatus } from '../shared/api.js';
import { toolActivity, type Activity } from '../shared/office-activity.js';

export { toolActivity, type Activity };
export type Activities = Partial<Record<ProviderId, Activity>>;
export type OfficeStatus = Activity | 'checking' | 'offline' | 'signed-out' | 'away' | 'idle';
export const ACTIVE_ACTIVITIES: readonly string[] = ['thinking', 'writing', 'tool', 'reading', 'editing', 'terminal', 'searching', 'database', 'consulting', 'reviewing'];

/** Visual state only: never starts a model, changes access, or changes the team. */
export function nextActivities(current: Activities, event: AppEvent): Activities {
  if (event.type === 'run_done') {
    return Object.fromEntries(Object.entries(current).map(([id, activity]) => [id,
      ACTIVE_ACTIVITIES.includes(activity)
        ? event.outcome.status === 'ok' ? 'done' : event.outcome.status === 'error' ? 'error' : 'cancelled'
        : activity,
    ]));
  }
  if (event.type === 'peer_activity') {
    const next: Activities = { ...current, [event.peer]: event.activity === 'tool' ? toolActivity(event.tool ?? '') : event.activity === 'thinking' ? 'reviewing' : event.activity };
    if (['thinking', 'writing', 'tool'].includes(event.activity)) next[event.self] = 'consulting';
    return next;
  }
  if (event.type === 'step' && event.step.status === 'running') {
    return { ...current, [event.step.provider]: event.step.kind === 'review' ? 'reviewing' : 'thinking' };
  }
  if (event.type !== 'room') return current;
  const e = event.event;
  let activity: Activity;
  switch (e.type) {
    case 'turn_start': activity = 'thinking'; break;
    case 'text': activity = 'writing'; break;
    case 'tool_call': activity = toolActivity(e.name); break;
    case 'tool_result': activity = 'thinking'; break;
    case 'limit':
      // Providers also report healthy quota windows through this event.
      if (e.status !== 'rejected') return current;
      activity = 'limited'; break;
    case 'turn_end': activity = e.status === 'ok' ? 'done' : e.status; break;
    default: return current;
  }
  return { ...current, [e.provider]: activity };
}

export function officeStatus(provider: ProviderStatus | undefined, participating: boolean, activity?: Activity): OfficeStatus {
  if (!provider) return 'checking';
  if (!provider.available) return 'offline';
  if (provider.signedIn === false) return 'signed-out';
  if (activity) return activity;
  return participating ? 'idle' : 'away';
}

export const STATUS_LABELS: Record<OfficeStatus, string> = {
  checking: 'Verificando conexão', offline: 'Não instalado', 'signed-out': 'Precisa entrar',
  away: 'Fora da equipe', idle: 'Aguardando', thinking: 'Pensando', writing: 'Respondendo',
  tool: 'Usando ferramenta', done: 'Concluído', error: 'Ocorreu um erro', cancelled: 'Cancelado', limited: 'Limite de uso',
  reading: 'Lendo arquivos', editing: 'Editando arquivos', terminal: 'No terminal', searching: 'Pesquisando',
  database: 'Consultando banco', consulting: 'Consultando colega', reviewing: 'Analisando a consulta',
};

export const ACTIVITY_BUBBLES: Partial<Record<OfficeStatus, string>> = {
  checking: 'Chegando ao escritório…', thinking: 'Deixa eu pensar…', writing: 'Preparando a resposta…',
  reading: 'Lendo os arquivos…', editing: 'Aplicando alterações…', terminal: 'Executando um comando…',
  searching: 'Buscando informações…', database: 'Consultando o banco…', consulting: 'Pedindo uma segunda opinião…',
  reviewing: 'Analisando a consulta do colega…', tool: 'Usando uma ferramenta…',
  done: 'Prontinho!', error: 'Encontrei um problema.', cancelled: 'Parei por aqui.', limited: 'Preciso esperar meu limite renovar.',
};

/** Extend this registry with future cosmetic skins; provider identity stays separate. */
export const OFFICE_SKINS = {
  classic: {
    claude: { color: '#e89166', accent: '#ffe0b1', shape: 'sun' },
    gemini: { color: '#9692f4', accent: '#c7efff', shape: 'star' },
    codex: { color: '#65c8af', accent: '#d8fff0', shape: 'bot' },
  },
} as const;
