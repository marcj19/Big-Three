import type { MessageView, PendingQuestion, ProviderId, StepKind } from '../shared/api.js';
import { splitQuestion, visibleReply } from '@aio/room/question';
import { api, writeClipboardText } from './bridge.js';
import { ctx } from './ctx.js';
import { clear, formatTime, h, renderRichText, syncChildren } from './dom.js';
import { normalizeChatMarkdown } from './markdown.js';
import { icon, providerMark } from './icons.js';
import { NAMES, PROVIDERS, ready, saveConfig, STARTERS, state, type LiveTurn } from './state.js';
import { toast } from './ui.js';
import { renderOffice } from './office.js';
import { appearance, setAppearance } from './theme.js';
import { harnessToolbar, conversationRuns, workCard, matchRun, activeRunRecord, showRunActivity } from './harness.js';
import { toolLabel } from '../shared/work-trace.js';

export const topbarEl = h('header', { class: 'topbar' });
const runStatus = h('div', { class: 'run-live-status', 'aria-live': 'polite' });
const questions = h('div', { class: 'run-questions' });
export const runHeaderEl = h('section', { class: 'run-live-header', 'aria-label': 'Execução em andamento', hidden: true }, runStatus, questions);
export const messagesEl = h('div', { class: 'messages', role: 'log', 'aria-live': 'polite', 'aria-relevant': 'additions', 'aria-label': 'Mensagens da conversa', tabindex: '-1' });
const column = h('div', { class: 'col' });
messagesEl.append(column);

// ---------- top bar ----------

let editing = false;

export function renderTopbar(): void {
  clear(topbarEl);
  const meta = state.current?.meta;
  topbarEl.append(
    h(
      'button',
      { class: 'icon-btn', type: 'button', 'aria-label': state.sidebarCollapsed ? 'Mostrar a barra lateral' : 'Esconder a barra lateral', 'aria-expanded': String(!state.sidebarCollapsed), title: 'Barra lateral', onClick: toggleSidebar },
      icon('menu'),
    ),
  );
  const modeButton = () => h('button', {
    class: 'btn office-toggle', type: 'button', 'aria-pressed': String(appearance.office3d),
    onClick: () => setAppearance({ office3d: !appearance.office3d }),
  }, appearance.office3d ? 'Voltar ao chat' : 'Escritório 3D');
  if (!meta) {
    topbarEl.append(h('div', { class: 'titles' }, h('h1', {}, 'Big Three')));
    topbarEl.append(harnessToolbar(), modeButton());
    return;
  }
  const subtitle = h('div', { class: 'subtitle', title: meta.cwd }, icon('folder', 'sm'), h('span', {}, meta.cwd));
  if (editing) {
    const input = h('input', {
      class: 'title-input',
      value: meta.title,
      'aria-label': 'Título da conversa',
      maxlength: '120',
      onKeydown: (e: KeyboardEvent) => {
        if (e.key === 'Enter') void commit(input.value);
        if (e.key === 'Escape') stop();
      },
      onBlur: () => void commit(input.value),
    });
    topbarEl.append(h('div', { class: 'titles' }, h('h1', {}, input), subtitle));
    queueMicrotask(() => {
      input.focus();
      input.select();
    });
  } else {
    topbarEl.append(
      h(
        'div',
        { class: 'titles' },
        h('h1', {}, h('button', { class: 'title-btn', type: 'button', title: 'Clique para renomear', onClick: () => { editing = true; renderTopbar(); } }, meta.title)),
        subtitle,
      ),
    );
  }

  topbarEl.append(harnessToolbar(), modeButton());

  function stop() {
    editing = false;
    renderTopbar();
  }
  async function commit(value: string) {
    if (!editing) return;
    editing = false;
    const title = value.trim();
    if (title && title !== meta!.title) {
      try {
        await api.renameConversation(meta!.id, title);
        meta!.title = title;
        await ctx.refreshConversations();
      } catch (err) {
        toast((err as Error).message, 'error');
      }
    }
    renderTopbar();
  }
}

function toggleSidebar(): void {
  state.sidebarCollapsed = !state.sidebarCollapsed;
  const shell = document.querySelector('.shell');
  shell?.classList.toggle('collapsed', state.sidebarCollapsed);
  shell?.classList.toggle('open', !state.sidebarCollapsed);
  renderTopbar();
}

// ---------- messages ----------

async function copy(code: string): Promise<void> {
  try {
    await writeClipboardText(code);
    toast('Copiado.', 'success');
  } catch {
    toast('Não foi possível copiar. Selecione o texto e use Ctrl+C.', 'error');
  }
}

function avatar(author: MessageView['author']): HTMLElement | '' {
  return author === 'user' || author === 'system' ? '' : h('span', { class: 'avatar sm', role: 'img', 'aria-label': NAMES[author] }, providerMark(author));
}

function messageNode(m: MessageView): HTMLElement {
  const name = m.author === 'user' ? 'Você' : m.author === 'system' ? 'Aviso' : NAMES[m.author];
  const assistant = m.author !== 'user' && m.author !== 'system';
  const parsed = assistant ? splitQuestion(m.text) : undefined;
  const options = parsed?.question.options ?? [];
  const readableText = parsed
    ? [parsed.body, parsed.question.question, options.map((option, index) => [index + 1, option].join('. ')).join('\n')].filter(Boolean).join('\n\n')
    : m.text;
  return h(
    'article',
    { class: `msg ${m.author}`, 'aria-label': `${name}, ${formatTime(m.at)}`, title: formatTime(m.at) },
    avatar(m.author),
    h(
      'div',
      { class: 'bubble' },
      // Your own messages carry no name, like in Messages; the time is in the tooltip and the accessible name.
      m.author === 'system' || m.author === 'user' ? '' : h('div', { class: 'who' }, name, h('span', { class: 'time' }, formatTime(m.at))),
      h('div', { class: 'text' }, renderRichText(parsed?.body ?? m.text, copy),
        parsed ? h('div', { class: 'body' }, renderRichText(parsed.question.question, copy), options.length ? h('ol', {}, ...options.map((option) => h('li', {}, option))) : '') : ''),
      m.attachments?.length ? h('div', { class: 'attachment-list', 'aria-label': 'Arquivos anexados' },
        ...m.attachments.map((name) => h('span', { class: 'attachment-chip', title: name }, icon('file', 'sm'), h('span', {}, name)))) : '',
      assistant ? h('div', { class: 'message-actions' }, h('button', { class: 'btn text', type: 'button', onClick: () => void copy(normalizeChatMarkdown(readableText)) }, 'Copiar resposta')) : '',
    ),
  );
}

function liveNode(t: LiveTurn): HTMLElement {
  const text = h('div', { class: 'text empty' });
  const tools = h('div', { class: 'tools' });
  const who = h('div', { class: 'who' }, NAMES[t.provider], h('span', { class: 'pulse', 'aria-hidden': 'true' }), h('span', { class: 'time', 'data-role': 'note' }, ''));
  const el = h('article', { class: `msg ${t.provider} live`, 'aria-label': `${NAMES[t.provider]} está respondendo` }, avatar(t.provider), h('div', { class: 'bubble' }, who, text, tools));
  updateLive(el, t);
  return el;
}

function updateLive(el: HTMLElement, t: LiveTurn): void {
  const text = el.querySelector<HTMLElement>('.text')!;
  const tools = el.querySelector<HTMLElement>('.tools')!;
  el.querySelector<HTMLElement>('[data-role=note]')!.textContent = t.note ?? 'escrevendo…';
  const response = visibleReply(t.text);
  if (response !== (text.dataset.shown ?? '')) {
    text.dataset.shown = response;
    text.classList.toggle('empty', !response);
    text.replaceChildren(response ? renderRichText(response, copy) : h('span', { class: 'dots', 'aria-hidden': 'true' }, h('i'), h('i'), h('i')));
  } else if (!response && !text.firstChild) {
    text.append(h('span', { class: 'dots', 'aria-hidden': 'true' }, h('i'), h('i'), h('i')));
  }
  const names = t.tools.slice(-1);
  if (tools.dataset.shown !== names.join('|')) {
    tools.dataset.shown = names.join('|');
    tools.replaceChildren(...names.map((n) => h('span', { class: 'tool' }, icon('terminal', 'sm'), toolLabel(n))));
  }
}

const STEP_NAMES: Record<StepKind, string> = {
  answer: 'Resposta', plan: 'Planejamento', execute: 'Implementação', review: 'Revisão', revise: 'Ajustes', debate: 'Debate',
};
const AGENT_STATUS = { running: 'Em andamento', done: 'Concluído', error: 'Falhou', cancelled: 'Cancelado', skipped: 'Ignorado' };

function questionForm(runId: string, question: PendingQuestion): HTMLElement {
  const answer = h('textarea', { rows: '2', maxlength: '4000', 'aria-label': 'Sua resposta', placeholder: 'Digite sua resposta…', required: true });
  const submit = h('button', { class: 'btn primary', type: 'submit' }, 'Responder e continuar');
  const error = h('p', { class: 'run-question-error', role: 'alert' });
  return h('form', { class: 'run-question', role: 'group', 'aria-label': 'Pergunta para você', onSubmit: async (event: Event) => {
    event.preventDefault();
    if (!answer.value.trim() || submit.disabled) return;
    submit.disabled = true;
    error.textContent = '';
    try { await api.answerQuestion(runId, question.id, answer.value.trim()); }
    catch (err) { error.textContent = (err as Error).message; submit.disabled = false; }
  } },
  h('div', { class: 'run-question-label' }, avatar(question.provider), h('b', {}, `${NAMES[question.provider]} precisa da sua resposta`)),
  h('div', { class: 'run-question-text' }, renderRichText(question.question, copy)),
  question.options?.length ? h('div', { class: 'run-question-options' }, ...question.options.map((option) => h('button', {
    class: 'btn tonal', type: 'button', onClick: () => { answer.value = option; answer.focus(); },
  }, option))) : '',
  answer, h('div', { class: 'run-question-actions' }, error, submit));
}

function renderRunHeader(): void {
  const current = state.current?.meta.id;
  const run = state.run?.conversationId === current ? state.run : undefined;
  const pending = state.pending?.conversationId === current ? state.pending : undefined;
  const elsewhere = !run && state.run?.questions.length ? state.run : undefined;
  runHeaderEl.hidden = !(run || pending || elsewhere);
  const record = run ? activeRunRecord() : undefined;
  const participants = run?.live.filter((turn) => !turn.finished) ?? [];
  const delegated = record?.entries.filter((entry) => entry.kind === 'consult' || entry.kind === 'subagent') ?? [];
  const active = delegated.filter((entry) => entry.status === 'running');
  const shown = [...active, ...delegated.filter((entry) => entry.status !== 'running').reverse()].slice(0, 6);
  const step = run?.step;
  const caption = run?.stopping ? 'Parando execução…' : run?.questions.length ? 'Aguardando sua resposta'
    : step ? `Etapa ${step.index + 1} de ${step.total} · ${STEP_NAMES[step.kind]}`
      : run ? 'Execução em andamento' : 'Enviando tarefa…';
  const lead = run?.lead ?? pending?.lead;
  const signature = JSON.stringify([run?.runId, elsewhere?.runId, caption, lead, participants.map((turn) => [turn.provider, turn.note]), shown, active.length, delegated.length]);
  if (runStatus.dataset.view !== signature) {
    runStatus.dataset.view = signature;
    runStatus.replaceChildren();
    if (elsewhere) {
      runStatus.append(h('button', { class: 'btn tonal', type: 'button', onClick: () => void ctx.openConversation(elsewhere.conversationId) }, 'Responder pergunta em outra conversa'));
    } else if (lead) {
      runStatus.append(
        h('div', { class: 'run-live-heading' },
          h('b', {}, caption),
          run ? h('button', { class: 'btn text', type: 'button', onClick: () => showRunActivity(run.runId) }, 'Ver atividade') : ''),
        h('div', { class: 'run-live-people' },
          ...(participants.length ? participants.map((turn) => h('span', { class: 'run-live-chip' }, avatar(turn.provider), h('b', {}, NAMES[turn.provider]), h('span', {}, turn.note ?? 'Trabalhando…')))
            : [h('span', { class: 'run-live-chip' }, avatar(step?.provider ?? lead), h('b', {}, NAMES[step?.provider ?? lead]), h('span', {}, run?.questions.length ? 'Aguardando resposta' : run ? 'Preparando a próxima ação' : 'Modelo escolhido'))])),
      );
      if (delegated.length) runStatus.append(h('div', { class: 'run-live-delegated' },
        h('b', {}, `Subagentes · ${active.length} em andamento`),
        h('div', { class: 'run-live-people' }, ...shown.map((entry) => {
          const provider = entry.peer ?? entry.provider!;
          const title = entry.peer ? NAMES[provider] : entry.label;
          const detail = entry.detail ?? AGENT_STATUS[entry.status];
          return h('span', { class: 'run-live-chip delegated', title: detail }, avatar(provider), h('b', {}, title), h('span', {}, detail));
        }))));
    }
  }
  const question = run?.questions[0];
  if (questions.dataset.id !== (question?.id ?? '')) {
    questions.dataset.id = question?.id ?? '';
    questions.replaceChildren(...(run && question ? [questionForm(run.runId, question)] : []));
  }
}

function emptyState(): HTMLElement {
  const starter = (st: (typeof STARTERS)[number]) =>
    h(
      'button',
      {
        class: 'idea',
        type: 'button',
        onClick: () => {
          if (st.team) {
            // A second opinion needs someone to ask: switch on whoever is ready.
            for (const p of PROVIDERS) if (p !== state.config.lead.provider && ready(p)) state.config.team[p].enabled = true;
            saveConfig();
            ctx.renderComposer();
          }
          ctx.setPrompt(st.text);
          ctx.focusComposer();
        },
      },
      h('span', { class: 'ic' }, icon(st.icon)),
      h('b', {}, st.title),
    );
  return h(
    'div',
    { class: 'empty' },
    h('div', { class: 'trio', 'aria-hidden': 'true' }, ...PROVIDERS.map((p) => h('span', { class: 'avatar' }, providerMark(p)))),
    h('h2', {}, 'Como posso ajudar?'),
    h('p', {}, 'Escolha com quem conversar e peça. Se precisar, ele consulta os outros por conta própria; você também pode pedir no chat.'),
    h('div', { class: 'ideas' }, ...STARTERS.map(starter)),
  );
}

// ---------- consultations between models ----------

type Shown =
  | { kind: 'message'; message: MessageView }
  | { kind: 'consult'; asker: ProviderId; peer: ProviderId; question: string; index: number; answer?: MessageView };

const ASK = /^\(to (claude|gemini|codex)\) ([\s\S]*)$/;

/** A model's question to a colleague and the colleague's answer are shown together, as one step of the work. */
function group(messages: MessageView[]): Shown[] {
  const out: Shown[] = [];
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i]!;
    const ask = m.author !== 'user' && m.author !== 'system' ? ASK.exec(m.text) : null;
    if (!ask) {
      out.push({ kind: 'message', message: m });
      continue;
    }
    const peer = ask[1] as ProviderId;
    const next = messages[i + 1];
    const answered = next?.author === peer ? next : undefined;
    out.push({ kind: 'consult', asker: m.author as ProviderId, peer, question: ask[2]!, index: m.index, answer: answered });
    if (answered) i++;
  }
  return out;
}

function consultNode(item: Extract<Shown, { kind: 'consult' }>): HTMLElement {
  const body = h('div', { class: 'consult-body' });
  const el = h(
    'article',
    { class: 'msg consult-msg', 'aria-label': `${NAMES[item.asker]} consultou ${NAMES[item.peer]}` },
    h(
      'details',
      { class: 'consult' },
      h(
        'summary',
        {},
        h('span', { class: 'avatar xs' }, providerMark(item.asker)),
        icon('arrow', 'sm'),
        h('span', { class: 'avatar xs' }, providerMark(item.peer)),
        h('span', { class: 'consult-title' }, `${NAMES[item.asker]} consultou ${NAMES[item.peer]}`),
        h('span', { class: 'consult-state', 'data-role': 'state' }, ''),
        icon('chevron', 'sm'),
      ),
      body,
    ),
  );
  updateConsult(el, item);
  return el;
}

function updateConsult(el: HTMLElement, item: Extract<Shown, { kind: 'consult' }>): void {
  const stateKey = item.answer ? 'answered' : state.run ? 'waiting' : 'none';
  if (el.dataset.state === stateKey) return;
  el.dataset.state = stateKey;
  el.querySelector('[data-role=state]')!.textContent = item.answer ? 'respondido' : state.run ? 'aguardando resposta…' : 'sem resposta';
  el.querySelector('.consult-body')!.replaceChildren(
    h('div', { class: 'q' }, h('b', {}, 'Pergunta'), renderRichText(item.question, copy)),
    item.answer ? h('div', { class: 'a' }, h('b', {}, `Resposta de ${NAMES[item.peer]}`), renderRichText(item.answer.text, copy)) : '',
  );
}

export function renderMessages(instant = false): void {
  renderOffice();
  ctx.renderHarness();
  renderRunHeader();
  const nearBottom = messagesEl.scrollHeight - messagesEl.scrollTop - messagesEl.clientHeight < 160;
  const conv = state.current;
  const run = state.run?.conversationId === conv?.meta.id ? state.run : undefined;
  const pending = state.pending?.conversationId === conv?.meta.id ? state.pending : undefined;
  const items: Parameters<typeof syncChildren>[1] = [];
  if (!conv || (conv.messages.length === 0 && !run && !pending)) {
    items.push({ key: 'empty', create: emptyState });
  } else {
    const messages = pending ? [...conv.messages, pending.message] : conv.messages;
    for (const shown of group(messages)) {
      if (shown.kind === 'message') {
        const optimistic = shown.message === pending?.message;
        items.push({ key: optimistic ? `pending:${conv.meta.id}` : `m:${conv.meta.id}:${shown.message.index}`, create: () => messageNode(shown.message) });
        if (shown.message.author === 'user') {
          const record = optimistic && run ? activeRunRecord() : matchRun(shown.message, conversationRuns());
          if (record) items.push({ key: `run:${record.id}`, create: () => workCard(record), update: (el) => workCard(record, el) });
        }
      }
      else items.push({ key: `c:${conv.meta.id}:${shown.index}`, create: () => consultNode(shown), update: (el) => updateConsult(el, shown) });
    }
    for (const t of run?.live ?? []) items.push({ key: `live:${t.provider}:${conv.meta.id}`, create: () => liveNode(t), update: (el) => updateLive(el, t) });
  }
  // Opening another conversation shows its history at once; only messages that arrive later animate in.
  column.classList.toggle('instant', instant);
  syncChildren(column, items);
  if (nearBottom) messagesEl.scrollTop = messagesEl.scrollHeight;
}

export function scrollToEnd(): void {
  messagesEl.scrollTop = messagesEl.scrollHeight;
}
