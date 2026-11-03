import type { Access, ConnectionView, ConversationMeta, MessageView, ModelOption, ProviderId, ProviderStatus, RunSpec, UsageView } from '../shared/api.js';
import type { IconName } from './icons.js';

export const PROVIDERS: ProviderId[] = ['claude', 'gemini', 'codex'];
export const NAMES: Record<ProviderId, string> = { claude: 'Claude', gemini: 'Gemini', codex: 'Codex' };

export const ACCESS_META: Record<Access, { label: string; short: string; icon: IconName; hint: string }> = {
  'read-only': { label: 'Somente leitura', short: 'Ler', icon: 'eye', hint: 'O modelo só lê. Nada é alterado.' },
  edit: { label: 'Pode editar arquivos', short: 'Editar', icon: 'pencil', hint: 'O modelo pode criar e editar arquivos na pasta da conversa.' },
  full: { label: 'Acesso total', short: 'Total', icon: 'bolt', hint: 'O modelo pode rodar comandos e alterar arquivos sem pedir.' },
};

/** A model and the choices made for it. `customModel` marks a name typed by hand. */
export interface Pick {
  model?: string;
  effort?: string;
  customModel?: boolean;
}
export interface LeadPick extends Pick {
  provider: ProviderId;
}
export interface TeamPick extends Pick {
  enabled: boolean;
}

export interface Config {
  /** The model you talk to. */
  lead: LeadPick;
  access: Access;
  /** Colleagues the lead may consult on its own, each on the model chosen here. */
  team: Record<ProviderId, TeamPick>;
  /** Another model takes over if the lead runs out of quota (never while it may change files). */
  fallback: boolean;
  connections: string[];
}

export interface LiveTurn {
  provider: ProviderId;
  text: string;
  tools: string[];
  note?: string;
}

export interface RunState {
  runId: string;
  conversationId: string;
  live: LiveTurn[];
}

export const state = {
  providers: [] as ProviderStatus[],
  providersLoading: false,
  models: {} as Partial<Record<ProviderId, ModelOption[]>>,
  connections: [] as ConnectionView[],
  conversations: [] as ConversationMeta[],
  current: undefined as { meta: ConversationMeta; messages: MessageView[] } | undefined,
  run: undefined as RunState | undefined,
  usage: {} as Record<string, UsageView>,
  loginOutput: {} as Partial<Record<ProviderId, string[]>>,
  sidebarCollapsed: false,
  config: {
    lead: { provider: 'claude' },
    access: 'read-only',
    team: { claude: { enabled: true }, gemini: { enabled: true }, codex: { enabled: true } },
    fallback: true,
    connections: [],
  } as Config,
};

export const provider = (id: ProviderId): ProviderStatus | undefined => state.providers.find((p) => p.id === id);
export const usable = (id: ProviderId): boolean => provider(id)?.available === true;
/** Installed and not known to be signed out. */
export const ready = (id: ProviderId): boolean => usable(id) && provider(id)?.signedIn !== false;

/** Whether the model you talk to can call colleagues (its CLI must accept MCP servers). */
export const canLead = (id: ProviderId): boolean => provider(id)?.supportsMcp === true;
/** Colleagues that are on the team, installed, and not the lead. */
export const teamMembers = (c: Config = state.config): ProviderId[] => PROVIDERS.filter((p) => p !== c.lead.provider && c.team[p].enabled && ready(p));

/** Label of the model chosen for one provider, as the picker shows it. */
export function modelLabel(p: ProviderId, pick: Pick): string {
  if (!pick.model) return 'Padrão';
  return state.models[p]?.find((m) => m.id === pick.model)?.label ?? pick.model;
}

const KEY = 'aio.config.v3';

export function loadConfig(): void {
  try {
    const saved = JSON.parse(localStorage.getItem(KEY) ?? 'null') as Partial<Config> | null;
    if (saved?.lead?.provider && PROVIDERS.includes(saved.lead.provider)) state.config.lead = { ...saved.lead };
    if (saved?.team) for (const p of PROVIDERS) if (saved.team[p]) state.config.team[p] = { ...state.config.team[p], ...saved.team[p] };
    if (typeof saved?.fallback === 'boolean') state.config.fallback = saved.fallback;
    // Write access is never remembered between sessions: it has to be chosen again each time.
  } catch {
    /* storage unavailable: defaults are fine */
  }
}

export function saveConfig(): void {
  try {
    const { lead, team, fallback } = state.config;
    localStorage.setItem(KEY, JSON.stringify({ lead, team, fallback }));
  } catch {
    /* ignore */
  }
}

/** Turns the choices into what the main process expects. Throws a readable message when something is missing. */
export function buildSpec(c: Config): RunSpec {
  const p = provider(c.lead.provider);
  if (!p?.available) throw new Error(`${NAMES[c.lead.provider]} não está instalado neste computador.`);
  if (p.signedIn === false) throw new Error(`${NAMES[c.lead.provider]} não está conectado. Use "Entrar" na barra lateral.`);
  const choice = (id: ProviderId, pick: Pick) => ({ provider: id, model: pick.model || undefined, effort: pick.effort || undefined });
  return {
    kind: 'lead',
    lead: choice(c.lead.provider, c.lead),
    access: c.access,
    team: teamMembers(c).map((id) => choice(id, c.team[id])),
    fallback: c.fallback,
  };
}

/** Quick starting points for the empty screen; each one is just text to send. */
export const STARTERS: { icon: IconName; title: string; text: string; team?: boolean }[] = [
  { icon: 'folder', title: 'Entender o projeto', text: 'Explique a estrutura deste projeto e como rodá-lo.' },
  { icon: 'alert', title: 'Procurar bugs', text: 'Procure os bugs mais prováveis neste projeto e me mostre os mais graves, com o arquivo e a linha.' },
  { icon: 'users', title: 'Segunda opinião', text: 'Responda e depois peça a um colega da equipe para revisar criticamente a sua resposta. Diga o que ele achou.', team: true },
  { icon: 'plan', title: 'Planejar uma mudança', text: 'Planeje esta mudança antes de mexer em qualquer coisa e me mostre o plano para eu aprovar: ' },
];
