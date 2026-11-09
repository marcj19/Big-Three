import type { ProviderId, RunRecord, WorkEntry } from './api.js';
import { toolActivity, type Activity } from './office-activity.js';

const PROVIDERS = ['claude', 'gemini', 'codex'] as const;
export interface OfficeAgentView {
  id: ProviderId;
  status: Activity | 'idle';
  label: string;
  conversationId?: string;
  conversation?: string;
}

function activity(entry: WorkEntry, provider: ProviderId): OfficeAgentView['status'] {
  if (entry.kind === 'question') return 'idle';
  if (entry.kind === 'consult') return entry.peer === provider ? 'reviewing' : 'consulting';
  if (entry.kind === 'tool') return toolActivity(entry.tool ?? '');
  if (entry.label === 'Preparando a resposta') return 'writing';
  return 'thinking';
}

export function mobileOffice(runs: readonly RunRecord[], titles: ReadonlyMap<string, string>): OfficeAgentView[] {
  return PROVIDERS.map((id) => {
    for (const run of runs) {
      if (run.status !== 'running') continue;
      const entry = run.entries.slice().reverse().find((entry) => entry.status === 'running' && (entry.provider === id || entry.peer === id));
      if (!entry) continue;
      const label = entry.kind === 'consult' && entry.peer === id ? 'Analisando uma consulta' : entry.label;
      return { id, status: activity(entry, id), label, conversationId: run.conversationId, conversation: titles.get(run.conversationId) };
    }
    return { id, status: 'idle', label: 'Aguardando uma tarefa' };
  });
}
