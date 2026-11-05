import type { AppEvent, ProviderId, RunRecord, StartRun, WorkEntry } from './api.js';

const NAMES: Record<ProviderId, string> = { claude: 'Claude', gemini: 'Gemini', codex: 'Codex' };
const STEPS = { answer: 'Resposta', plan: 'Planejamento', execute: 'Implementação', review: 'Revisão', revise: 'Ajustes', debate: 'Debate' };
export function toolLabel(name: string): string {
  const value = name.toLowerCase();
  if (/ask_peer/.test(value)) return 'Consultando um colega';
  if (/agent|delegate|teamwork/.test(value)) return 'Delegando a um subagente';
  if (/query|sql|schema|database|list_tables/.test(value)) return 'Consultando banco de dados';
  if (/apply_patch|write_file|edit_file|multiedit|(^|__|\.)edit$|(^|__|\.)write$/.test(value)) return 'Alterando arquivos';
  if (/search|grep|glob/.test(value)) return 'Pesquisando';
  if (/read_file|read_room|(^|__|\.)read$|open_file|view_file|list_directory/.test(value)) return 'Lendo arquivos';
  if (/exec_command|shell|terminal|bash|run_command/.test(value)) return 'Executando comando';
  return 'Usando ferramenta';
}
export function newRunRecord(id: string, input: StartRun, at = new Date().toISOString()): RunRecord {
  return { id, conversationId: input.conversationId, prompt: input.prompt.slice(0, 400), startedAt: at, status: 'running',
    inputTokens: 0, outputTokens: 0, entries: [{ id: 1, at, kind: 'start', status: 'done', label: 'Tarefa recebida', detail: input.prompt.slice(0, 400) }] };
}

/** Mutates only the visual journal. No tools, prompts or permissions are executed from this data. */
export function recordWork(record: RunRecord, event: AppEvent, at = new Date().toISOString()): void {
  const latest = (predicate: (entry: WorkEntry) => boolean) => record.entries.slice().reverse().find(predicate);
  const add = (entry: Omit<WorkEntry, 'id' | 'at'>) => {
    const id = (record.entries.at(-1)?.id ?? 0) + 1;
    if (record.entries.length >= 500) record.entries.splice(1, 1);
    record.entries.push({ ...entry, id, at });
  };
  const finishPhases = (provider: ProviderId) => { for (const entry of record.entries) if (entry.provider === provider && entry.kind === 'phase' && entry.status === 'running') entry.status = 'done'; };
  if (event.type === 'room') {
    const e = event.event;
    if (e.type === 'turn_start') { finishPhases(e.provider); add({ kind: 'phase', provider: e.provider, status: 'running', label: `${NAMES[e.provider]} está trabalhando` }); }
    else if (e.type === 'text') {
      const phase = latest((entry) => entry.provider === e.provider && entry.kind === 'phase' && entry.status === 'running');
      if (phase?.label !== 'Preparando a resposta') { finishPhases(e.provider); add({ kind: 'phase', provider: e.provider, status: 'running', label: 'Preparando a resposta' }); }
    } else if (e.type === 'tool_call') {
      finishPhases(e.provider); add({ kind: 'tool', provider: e.provider, status: 'running', label: toolLabel(e.name), tool: e.name.slice(0, 160) });
    } else if (e.type === 'tool_result') {
      const entry = latest((entry) => entry.provider === e.provider && entry.kind === 'tool' && entry.status === 'running' && (!e.name || entry.tool === e.name));
      if (entry) entry.status = e.isError ? 'error' : 'done';
      finishPhases(e.provider);
      add({ kind: 'phase', provider: e.provider, status: 'running', label: e.isError ? 'Verificando erro de ferramenta' : 'Conferindo o resultado' });
    } else if (e.type === 'subagent') {
      const entry = latest((item) => item.kind === 'subagent' && item.provider === e.provider && item.activityId === e.agentId);
      if (entry) {
        entry.status = e.status;
        if (e.detail) entry.detail = e.detail;
      } else {
        add({ kind: 'subagent', provider: e.provider, activityId: e.agentId, label: e.label, detail: e.detail, status: e.status });
      }
    } else if (e.type === 'turn_end') {
      finishPhases(e.provider);
      for (const entry of record.entries) if (entry.provider === e.provider && entry.kind === 'tool' && entry.status === 'running') {
        entry.status = e.status === 'ok' ? 'done' : e.status;
        entry.detail = e.status === 'ok' ? 'Turno encerrado; a CLI não informou um resultado separado desta ferramenta.' : e.error ?? 'Turno interrompido.';
      }
      record.inputTokens += e.inputTokens; record.outputTokens += e.outputTokens;
      add({ kind: 'phase', provider: e.provider, status: e.status === 'ok' ? 'done' : e.status, label: e.status === 'ok' ? 'Resposta concluída' : e.status === 'cancelled' ? 'Turno cancelado' : 'Falha no turno', detail: e.error });
    } else if (e.type === 'skipped') add({ kind: 'notice', provider: e.provider, status: 'skipped', label: 'Modelo ignorado', detail: e.reason });
    else if (e.type === 'limit' && e.status === 'rejected') add({ kind: 'notice', provider: e.provider, status: 'error', label: 'Limite de uso atingido' });
  } else if (event.type === 'peer_activity') {
    let entry = latest((entry) => entry.kind === 'consult' && entry.provider === event.self && entry.peer === event.peer && entry.status === 'running');
    if (!entry) {
      add({ kind: 'consult', provider: event.self, peer: event.peer, status: 'running', label: `${NAMES[event.self]} → ${NAMES[event.peer]}` });
      entry = record.entries.at(-1)!;
    }
    entry.detail = event.activity === 'thinking' ? `${NAMES[event.peer]} está analisando a consulta` : event.activity === 'writing' ? `${NAMES[event.peer]} está preparando a resposta`
      : event.activity === 'tool' ? `${NAMES[event.peer]}: ${toolLabel(event.tool ?? '')}` : 'Consulta encerrada';
    if (['done', 'error', 'cancelled'].includes(event.activity)) entry.status = event.activity as 'done' | 'error' | 'cancelled';
  } else if (event.type === 'question') {
    add({ kind: 'question', activityId: event.question.id, provider: event.question.provider, status: 'running', label: 'Aguardando sua resposta' });
  } else if (event.type === 'question_answered') {
    const entry = latest((item) => item.kind === 'question' && item.activityId === event.questionId);
    if (entry) entry.status = 'done';
  } else if (event.type === 'project_preview') {
    record.previewUrl = event.url;
    add({ kind: 'notice', status: 'done', label: 'Prévia local disponível', detail: event.url });
  } else if (event.type === 'step') {
    let entry = record.entries.find((entry) => entry.kind === 'step' && entry.stepIndex === event.step.index);
    if (!entry) { add({ kind: 'step', provider: event.step.provider, stepIndex: event.step.index, status: event.step.status, label: `${event.step.index + 1}. ${STEPS[event.step.kind]}` }); entry = record.entries.at(-1)!; }
    entry.status = event.step.status; entry.detail = event.step.error ?? event.step.note;
  } else if (event.type === 'run_done') {
    record.status = event.outcome.status; record.endedAt = at;
    for (const entry of record.entries) if (entry.status === 'running') entry.status = event.outcome.status === 'ok' ? 'done' : event.outcome.status;
    add({ kind: 'finish', status: event.outcome.status === 'ok' ? 'done' : event.outcome.status, label: event.outcome.status === 'ok' ? 'Tarefa concluída' : event.outcome.status === 'cancelled' ? 'Tarefa cancelada' : 'Tarefa encerrada com erro', detail: event.outcome.error });
  }
}
