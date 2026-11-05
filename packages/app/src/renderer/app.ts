import type { AppEvent } from '../shared/api.js';
import { api, onEvent } from './bridge.js';
import { messagesEl, renderMessages, renderTopbar, scrollToEnd, topbarEl } from './chat.js';
import { composerEl, focusComposer, promptEl, renderComposer, setPrompt } from './composer.js';
import { ctx } from './ctx.js';
import { h } from './dom.js';
import { installIcons } from './icons.js';
import { renderSidebar, sidebarEl } from './sidebar.js';
import { buildSpec, canLead, loadConfig, NAMES, PROVIDERS, ready, saveConfig, state, teamMembers } from './state.js';
import { loadAppearance } from './theme.js';
import { openDialog, toast } from './ui.js';
import { initOffice, officeEl, onOfficeEvent, startOfficeRun } from './office.js';
import { harnessEl, initHarness, onHarnessEvent, openBrowser, renderHarness, startHarnessRun, togglePanel, loadHarnessConversation } from './harness.js';

loadAppearance();
installIcons();
loadConfig();

promptEl.id = 'prompt';
const root = document.getElementById('app')!;
root.append(
  h('a', { class: 'skip', href: '#prompt', onClick: (e: Event) => { e.preventDefault(); promptEl.focus(); } }, 'Ir para a mensagem'),
  h('div', { class: 'shell' }, sidebarEl, h('main', { class: 'main', id: 'main' }, topbarEl,
    h('div', { class: 'workbench' }, h('div', { class: 'workspace' }, officeEl, h('section', { class: 'chat-pane', 'aria-label': 'Chat' }, messagesEl, composerEl)), harnessEl))),
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

async function openConversation(id: string, keepScroll = false): Promise<void> {
  try {
    state.current = await api.getConversation(id);
  } catch (err) {
    state.current = undefined;
    fail(err);
  }
  renderSidebar();
  renderTopbar();
  renderMessages(!keepScroll);
  loadHarnessConversation();
  if (!keepScroll) scrollToEnd();
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

async function send(): Promise<void> {
  if (state.run) return;
  const text = promptEl.value.trim();
  if (!text) return void promptEl.focus();
  try {
    if (!state.current && !(await newConversation())) return;
    const spec = buildSpec(state.config);
    const conversationId = state.current!.meta.id;
    const { runId } = await api.startRun({ conversationId, prompt: text, spec, connections: state.config.connections, peerTools: canLead(state.config.lead.provider) && teamMembers().length > 0 });
    state.run = { runId, conversationId, live: [] };
    startHarnessRun(runId, { conversationId, prompt: text, spec, connections: state.config.connections, peerTools: canLead(state.config.lead.provider) && teamMembers().length > 0 });
    startOfficeRun(conversationId);
    setPrompt('');
    state.current = await api.getConversation(conversationId);
    renderComposer();
    renderMessages();
    scrollToEnd();
  } catch (err) {
    fail(err);
  }
}

// ---------- events from the main process ----------

function onAppEvent(ev: AppEvent): void {
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
  if (!state.run || ev.runId !== state.run.runId) return;
  onOfficeEvent(ev);
  if (ev.type === 'room') {
    const e = ev.event;
    const live = state.run.live;
    if (e.type === 'turn_start') {
      const i = live.findIndex((l) => l.provider === e.provider);
      if (i >= 0) live.splice(i, 1);
      live.push({ provider: e.provider, text: '', tools: [], note: 'trabalhando…' });
    } else if (e.type === 'text') {
      const turn = live.find((l) => l.provider === e.provider);
      if (turn) { turn.text = e.partial ? turn.text + e.text : e.text; turn.note = 'preparando resposta…'; }
    } else if (e.type === 'tool_call') {
      live.find((l) => l.provider === e.provider)?.tools.push(e.name);
    } else if (e.type === 'tool_result') {
      const turn = live.find((l) => l.provider === e.provider);
      if (turn) turn.note = e.isError ? 'conferindo um problema na ferramenta…' : 'conferindo o resultado…';
    } else if (e.type === 'skipped') {
      toast(`${NAMES[e.provider]} foi ignorado: ${e.reason}.`);
    } else if (e.type === 'turn_end') {
      // The finished message is in the transcript now; swap the live preview for it.
      void api.getConversation(ev.conversationId).then((c) => {
        if (state.current?.meta.id === c.meta.id) state.current = c;
        const run = state.run;
        if (run?.runId === ev.runId) run.live = run.live.filter((l) => l.provider !== e.provider);
        renderMessages();
        void refreshUsage();
      });
    }
    renderMessages();
  } else if (ev.type === 'run_done') {
    state.run = undefined;
    const o = ev.outcome;
    if (o.status === 'ok') {
      const verdict = o.verdict === 'approve' ? ' O revisor aprovou.' : o.verdict === 'changes' ? ' O revisor ainda pede mudanças.' : '';
      toast(`Concluído.${verdict}`, 'success');
    } else if (o.status === 'error') {
      toast(o.error ?? 'Algo deu errado.', 'error');
    } else {
      toast('Cancelado.');
    }
    renderComposer();
    void Promise.all([state.current?.meta.id === ev.conversationId ? openConversation(ev.conversationId, true) : Promise.resolve(), refreshConversations(), refreshUsage()]);
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
  send,
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
void Promise.all([refreshProviders(), refreshConnections(), refreshConversations(), refreshUsage()])
  .then(async () => {
    const first = state.conversations[0];
    if (first) await openConversation(first.id);
  })
  .catch(fail);
