import { ATTACHMENT_ONLY_PROMPT, type AppEvent, type ProviderId } from '../shared/api.js';
import { api, onEvent } from './bridge.js';
import { messagesEl, renameChat, renderMessages, renderTopbar, runAnnouncement, runHeaderEl, scrollToEnd, topbarEl } from './chat.js';
import { clearDraftFiles, composerEl, draftFiles, draftKey, encodeAttachment, focusComposer, promptEl, renderComposer, setPrompt } from './composer.js';
import { ctx } from './ctx.js';
import { h } from './dom.js';
import { installIcons } from './icons.js';
import { renderSidebar, sidebarEl } from './sidebar.js';
import { buildSpec, canLead, loadConfig, NAMES, PROVIDERS, ready, saveConfig, state, teamMembers } from './state.js';
import { loadAppearance } from './theme.js';
import { openDialog, toast } from './ui.js';
import { initOffice, officeEl, onOfficeEvent, startOfficeRun } from './office.js';
import { harnessEl, harnessResize, initHarness, onHarnessEvent, openBrowser, openProjectPreview, renderHarness, startHarnessRun, togglePanel, loadHarnessConversation } from './harness.js';
import { toolLabel } from '../shared/work-trace.js';
import { onUpdate } from './updates.js';

loadAppearance();
installIcons();
loadConfig();

promptEl.id = 'prompt';
const root = document.getElementById('app')!;
root.append(
  h('a', { class: 'skip', href: '#prompt', onClick: (e: Event) => { e.preventDefault(); promptEl.focus(); } }, 'Ir para a mensagem'),
  h('div', { class: 'shell' }, sidebarEl, h('main', { class: 'main', id: 'main' }, topbarEl,
    h('div', { class: 'workbench' }, h('div', { class: 'workspace' }, officeEl, h('section', { class: 'chat-pane', 'aria-label': 'Chat' }, runAnnouncement, runHeaderEl, messagesEl, composerEl)), harnessResize, harnessEl))),
);
initOffice();
initHarness();
new ResizeObserver(() => { topbarEl.parentElement?.style.setProperty('--topbar-h', `${topbarEl.offsetHeight}px`); }).observe(topbarEl);
window.addEventListener('aio:appearance', renderTopbar);

const fail = (err: unknown) => toast(err instanceof Error ? err.message : String(err), 'error');

// ---------- data ----------

async function refreshProviders(): Promise<void> {
  state.providersLoading = true;
  renderSidebar();
  try {
    state.providers = await api.providersStatus();
    // Models are fetched in the background: the list for Antigravity takes a second or two.
    void loadModels();
    // If the remembered lead is not usable here, start with one that is.
    if (!ready(state.config.lead.provider)) {
      const first = PROVIDERS.find(ready);
      if (first) state.config.lead = { provider: first };
    }
  } catch (err) {
    fail(err);
  }
  state.providersLoading = false;
  renderSidebar();
  renderComposer();
}
async function loadModels(): Promise<void> {
  await Promise.all(
    state.providers
      .filter((p) => p.available)
      .map(async (p) => {
        try {
          state.models[p.id] = await api.listModels(p.id);
        } catch {
          /* the default model is always there; a failing list must not get in the way */
        }
      }),
  );
  renderComposer();
}
async function refreshConnections(): Promise<void> {
  state.connections = await api.listConnections();
  state.config.connections = state.config.connections.filter((n) => state.connections.some((c) => c.name === n && c.hasPassword));
  renderSidebar();
  renderComposer();
}
async function refreshConversations(): Promise<void> {
  state.conversations = await api.listConversations();
  renderSidebar();
}
async function refreshUsage(): Promise<void> {
  state.usage = await api.usage();
  renderSidebar();
  void refreshQuotas();
}
/** Plan limits for the sidebar meters. A failed read leaves the last meters in place instead of showing an error. */
async function refreshQuotas(): Promise<void> {
  try {
    state.quotas = await api.accountQuotas();
    renderSidebar();
  } catch { /* keep the previous meters */ }
}
setInterval(() => void refreshQuotas(), 5 * 60_000);

let selection = 0;
let transcriptTicket = 0;
async function openConversation(id: string, keepScroll = false): Promise<void> {
  const ticket = ++selection;
  try {
    const conversation = await api.getConversation(id);
    if (ticket !== selection) return;
    state.current = conversation;
    reconcilePending();
  } catch (err) {
    if (ticket !== selection) return;
    state.current = undefined;
    fail(err);
  }
  renderSidebar();
  renderTopbar();
  renderComposer();
  renderMessages(!keepScroll);
  loadHarnessConversation();
  if (!keepScroll) scrollToEnd();
}

function reconcilePending(): void {
  const pending = state.pending;
  if (!pending || pending.conversationId !== state.current?.meta.id) return;
  if (state.current.messages.some((message) => message.author === 'user' && (pending.message.runId
    ? message.runId === pending.message.runId
    : message.index >= pending.message.index && message.text === pending.message.text))) {
    state.pending = undefined;
  }
}

async function refreshTranscript(id: string, savedProvider?: ProviderId): Promise<void> {
  if (state.current?.meta.id !== id) return;
  const selected = selection;
  const ticket = ++transcriptTicket;
  const run = state.run;
  const finished = run?.live.find((turn) => turn.finished && turn.provider === savedProvider);
  try {
    const conversation = await api.getConversation(id);
    if (selected !== selection || state.current?.meta.id !== id) return;
    if (finished && state.run === run && run) run.live = run.live.filter((turn) => turn !== finished);
    if (ticket === transcriptTicket) {
      const renamed = state.current.meta.title !== conversation.meta.title;
      // The transcript request can finish after the access selector already saved a new choice.
      state.current = { ...conversation, access: state.current.access };
      reconcilePending();
      if (renamed) renderTopbar();
    }
    renderMessages();
  } catch (err) { if (ticket === transcriptTicket && selected === selection) fail(err); }
}

// ---------- new conversation ----------

let creating: Promise<boolean> | undefined;

/** One folder dialog at a time: a second request while it is open or still saving joins the first. */
function newConversation(): Promise<boolean> {
  creating ??= createConversationFlow().finally(() => {
    creating = undefined;
  });
  return creating;
}

function askFolder(initial: string): Promise<string | null> {
  return new Promise((resolve) => {
    let chosen: string | null = null;
    openDialog({
      label: 'Pasta de trabalho',
      narrow: true,
      onClose: () => resolve(chosen),
      build: (close) => {
        const input = h('input', { value: initial, placeholder: 'C:\\Users\\você\\Projetos\\meu-projeto', autocomplete: 'off', spellcheck: 'false', autofocus: true });
        const submit = () => {
          chosen = input.value.trim() || null;
          close();
        };
        input.addEventListener('keydown', (e) => e.key === 'Enter' && submit());
        return h(
          'div',
          { class: 'dialog-pad' },
          h('h2', {}, 'Em qual pasta os modelos vão trabalhar?'),
          h('p', { class: 'muted' }, 'Eles enxergam esta pasta e as subpastas. Comece pelo menor escopo possível.'),
          h(
            'div',
            { class: 'fields' },
            h('label', { class: 'field wide' }, 'Pasta', h('span', { class: 'with-btn' }, input)),
            h('button', { class: 'btn wide-btn', type: 'button', onClick: async () => { const p = await api.pickFolder(); if (p) input.value = p; } }, 'Escolher no Windows…'),
          ),
          h('div', { class: 'row-end' }, h('button', { class: 'btn', type: 'button', onClick: close }, 'Cancelar'), h('button', { class: 'btn primary', type: 'button', onClick: submit }, 'Criar conversa')),
        );
      },
    });
  });
}

async function createConversationFlow(): Promise<boolean> {
  let last = '';
  try {
    last = localStorage.getItem('aio.cwd') ?? '';
  } catch {
    /* ignore */
  }
  const cwd = await askFolder(last);
  if (!cwd) return false;
  try {
    const meta = await api.createConversation({ cwd });
    try {
      localStorage.setItem('aio.cwd', cwd);
    } catch {
      /* ignore */
    }
    await refreshConversations();
    await openConversation(meta.id);
    focusComposer();
    return true;
  } catch (err) {
    fail(err);
    return false;
  }
}

// ---------- sending ----------

let starting: { conversationId: string; events: AppEvent[] } | undefined;

async function send(): Promise<void> {
  if (state.run || state.sending || state.accessChanging) return;
  const text = promptEl.value.trim();
  const key = draftKey();
  const files = draftFiles(key);
  if (!text && !files.length) return void promptEl.focus();
  state.sending = true;
  renderComposer();
  try {
    if (!state.current && !(await newConversation())) return;
    const conversation = state.current!;
    const conversationId = conversation.meta.id;
    const lead = state.config.lead.provider;
    const input = { conversationId, prompt: text || ATTACHMENT_ONLY_PROMPT, spec: buildSpec(state.config), connections: [...state.config.connections],
      peerTools: canLead(lead) && teamMembers().length > 0 };
    const attachments = files.length ? await Promise.all(files.map(encodeAttachment)) : undefined;
    const request = { conversationId, events: [] as AppEvent[] };
    starting = request;
    state.pending = { conversationId, lead, message: { index: (conversation.messages.at(-1)?.index ?? 0) + 1, author: 'user', text: input.prompt,
      at: new Date().toISOString(), attachments: attachments?.map((file) => file.name.trim()) } };
    setPrompt('');
    renderComposer();
    renderMessages();
    scrollToEnd();
    const { runId } = await api.startRun({ ...input, attachments });
    if (state.pending?.conversationId === conversationId) state.pending.message.runId = runId;
    clearDraftFiles(key);
    starting = undefined;
    state.run = { runId, conversationId, lead, live: [], questions: [], activePeers: new Set() };
    startHarnessRun(runId, input);
    startOfficeRun(conversationId, runId);
    for (const event of request.events) onAppEvent(event);
    void refreshTranscript(conversationId);
  } catch (err) {
    starting = undefined;
    state.pending = undefined;
    if (!promptEl.value) setPrompt(text);
    fail(err);
  } finally {
    state.sending = false;
    renderComposer();
    renderMessages();
  }
}

async function stopRun(runId: string): Promise<void> {
  const run = state.run?.runId === runId ? state.run : undefined;
  if (run?.stopping) return;
  if (run) {
    run.stopping = true;
    renderComposer();
    renderMessages();
    renderHarness();
  }
  try {
    await api.cancelRun(runId);
  } catch (err) {
    if (run && state.run === run) {
      run.stopping = false;
      renderComposer();
      renderMessages();
      renderHarness();
    }
    fail(err);
  }
}

// ---------- events from the main process ----------

function onAppEvent(ev: AppEvent): void {
  if (ev.type === 'update') return onUpdate(ev.state);
  if ('runId' in ev && starting?.conversationId === ev.conversationId) {
    starting.events.push(ev);
    return;
  }
  onHarnessEvent(ev);
  if (ev.type === 'browser') return;
  if (ev.type === 'login') {
    const lines = (state.loginOutput[ev.provider] ??= []);
    if (ev.event.type === 'output') {
      lines.push(ev.event.line);
      if (lines.length > 3) lines.shift();
    } else {
      delete state.loginOutput[ev.provider];
      if (ev.event.ok) toast(`${NAMES[ev.provider]} conectado.`, 'success');
      else toast(ev.event.message ?? `Não foi possível conectar o ${NAMES[ev.provider]}.`, 'error');
      void refreshProviders();
    }
    renderSidebar();
    return;
  }
  const run = state.run;
  if (!run || ev.runId !== run.runId) return;
  onOfficeEvent(ev);
  if (ev.type === 'room') {
    const e = ev.event;
    const live = run.live;
    if (e.type === 'turn_start') {
      const i = live.findIndex((l) => l.provider === e.provider);
      if (i >= 0) live.splice(i, 1);
      live.push({ provider: e.provider, text: '', tools: [], note: 'trabalhando…' });
    } else if (e.type === 'text') {
      const turn = live.find((l) => l.provider === e.provider);
      if (turn) { turn.text = e.partial ? turn.text + e.text : e.text; turn.note = 'Escrevendo a resposta'; turn.tools = []; }
    } else if (e.type === 'tool_call') {
      const turn = live.find((l) => l.provider === e.provider);
      if (turn) { turn.tools = [e.name]; turn.note = [toolLabel(e.name), e.context].filter(Boolean).join(' · '); }
    } else if (e.type === 'tool_result') {
      const turn = live.find((l) => l.provider === e.provider);
      if (turn) { turn.tools = []; turn.note = e.isError ? 'Verificando erro de ferramenta' : 'Conferindo o resultado'; }
    } else if (e.type === 'skipped') {
      toast(`${NAMES[e.provider]} foi ignorado: ${e.reason}.`);
    } else if (e.type === 'turn_end') {
      const turn = live.find((l) => l.provider === e.provider);
      if (turn) { turn.finished = true; turn.tools = []; turn.note = e.status === 'ok' ? 'Turno concluído' : e.status === 'cancelled' ? 'Turno cancelado' : 'Falha no turno'; }
      void refreshUsage().catch(fail);
    }
    renderMessages();
  } else if (ev.type === 'transcript') {
    void refreshTranscript(ev.conversationId, ev.provider);
  } else if (ev.type === 'peer_activity') {
    const key = [ev.self, ev.peer].join(':');
    const terminal = ev.activity === 'done' || ev.activity === 'error' || ev.activity === 'cancelled';
    if (terminal) run.activePeers.delete(key);
    else if (!run.activePeers.has(key)) {
      run.activePeers.add(key);
      void refreshTranscript(ev.conversationId);
    }
    if (terminal) void refreshTranscript(ev.conversationId);
    renderMessages();
  } else if (ev.type === 'step') {
    run.step = ev.step;
    renderMessages();
  } else if (ev.type === 'question' || ev.type === 'question_answered') {
    if (ev.type === 'question') run.questions.push(ev.question);
    else run.questions = run.questions.filter((question) => question.id !== ev.questionId);
    renderComposer();
    renderMessages();
  } else if (ev.type === 'project_preview') {
    if (state.current?.meta.id === ev.conversationId) openProjectPreview(ev.url);
    renderMessages();
  } else if (ev.type === 'run_done') {
    state.run = undefined;
    if (state.pending?.conversationId === ev.conversationId && ev.outcome.status === 'error') state.pending = undefined;
    const o = ev.outcome;
    if (state.current?.meta.id === ev.conversationId) runAnnouncement.textContent = o.status === 'ok' ? 'Execução concluída.'
      : o.status === 'cancelled' ? 'Execução cancelada.' : `Execução com erro. ${o.error ?? ''}`.trim();
    if (o.status === 'ok') {
      const verdict = o.verdict === 'approve' ? ' O revisor aprovou.' : o.verdict === 'changes' ? ' O revisor ainda pede mudanças.' : '';
      toast(`Concluído.${verdict}`, 'success');
    } else if (o.status === 'error') {
      toast(o.error ?? 'Algo deu errado.', 'error');
    } else {
      toast('Cancelado.');
    }
    renderComposer();
    renderMessages();
    void Promise.all([refreshTranscript(ev.conversationId), refreshConversations(), refreshUsage()]).catch(fail);
  }
}

// ---------- keyboard ----------

document.addEventListener('keydown', (e) => {
  if (e.defaultPrevented || document.querySelector('.backdrop')) return;
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'n') {
    e.preventDefault();
    void newConversation();
  }
});

// ---------- boot ----------

Object.assign(ctx, {
  refreshProviders,
  refreshConnections,
  refreshConversations,
  openConversation,
  newConversation,
  renameChat,
  send,
  stopRun,
  renderSidebar,
  renderTopbar,
  renderMessages,
  renderComposer,
  focusComposer,
  setPrompt,
  openBrowser, renderHarness, togglePanel,
});

renderSidebar();
renderTopbar();
renderMessages();
renderComposer();
onEvent(onAppEvent);
void api.update().then(onUpdate).catch(() => {});
void Promise.all([refreshProviders(), refreshConnections(), refreshConversations(), refreshUsage()])
  .then(async () => {
    const first = state.conversations[0];
    if (first) await openConversation(first.id);
  })
  .catch(fail);
