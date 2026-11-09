import type { AppEvent, ProviderId } from '../shared/api.js';
import { peerFailureDetail } from '../shared/work-trace.js';
import { ctx } from './ctx.js';
import { h } from './dom.js';
import { showRunActivity } from './harness.js';
import { canLead, NAMES, PROVIDERS, provider, saveConfig, state } from './state.js';
import { appearance, setAppearance } from './theme.js';
import { ACTIVITY_BUBBLES, nextActivities, officeStatus, STATUS_LABELS, type Activities, type OfficeStatus } from './office-model.js';
import type { OfficeScene } from './office-scene.js';
import { loadWardrobe, saveWardrobe, type Wardrobe } from './office-wardrobe.js';
import { openOfficeShop } from './office-shop.js';

const viewport = h('div', { class: 'office-viewport' });
const message = h('p', { class: 'office-loading', role: 'status' }, 'Preparando o escritório…');
const labels = h('div', { class: 'office-labels' });
const bubbles = h('div', { class: 'office-bubbles', 'aria-hidden': 'true' });
const detail = h('div', { class: 'office-detail', 'aria-live': 'polite' });
const cards = new Map<ProviderId, HTMLButtonElement>();
const badges = new Map<ProviderId, HTMLElement>();
const balloons = new Map<ProviderId, HTMLElement>();
const notes: Partial<Record<ProviderId, string>> = {};
const failures: Partial<Record<ProviderId, string>> = {};
const lastStatuses: Partial<Record<ProviderId, OfficeStatus>> = {};
const expires: Partial<Record<ProviderId, number>> = {};
let bubbleTimer: ReturnType<typeof setTimeout> | undefined;
let wardrobe: Wardrobe = loadWardrobe();
let selected: ProviderId = 'claude';
let activities: Activities = {};
let activityConversation: string | undefined;
let activityRunId: string | undefined;
let scene: OfficeScene | undefined;
let generation = 0;
let enabled = false;
let failed = false;
let lastView = '';

export const officeEl = h('section', { class: 'office', 'aria-label': 'Escritório 3D da equipe', hidden: true },
  h('header', { class: 'office-header' },
    h('div', {}, h('p', { class: 'office-eyebrow' }, 'BIG THREE · SEU ESCRITÓRIO'), h('h2', {}, 'Boas ideias precisam de espaço.'),
      h('p', { class: 'muted small' }, 'Três personalidades. Um trabalho em equipe.')),
    h('div', { class: 'office-header-actions' },
      h('button', { class: 'btn office-shop-button', type: 'button', onClick: () => {
        scene?.setPaused(true);
        openOfficeShop({ selected, value: wardrobe, onSave: (value) => {
          wardrobe = value; saveWardrobe(value); scene?.setWardrobe(value); officeEl.dataset.room = value.room;
        }, onClose: () => scene?.setPaused(false) });
      } }, 'Loja & estilo'),
      h('button', { class: 'btn', type: 'button', onClick: () => scene?.resetCamera(), title: 'Restaurar a câmera' }, 'Recentrar'))),
  viewport,
  h('p', { class: 'office-help' }, 'Arraste para girar · Role para aproximar · Escolha um personagem'),
  detail,
);
viewport.append(message, labels, bubbles);

for (const id of PROVIDERS) {
  const badge = h('span', { class: 'office-status' });
  const card = h('button', { type: 'button', class: `office-label ${id}`, 'aria-pressed': String(id === selected),
    onClick: () => select(id) }, h('b', {}, NAMES[id]), badge);
  cards.set(id, card);
  badges.set(id, badge);
  labels.append(card);
  const balloon = h('div', { class: `office-bubble ${id}`, 'data-provider': NAMES[id], hidden: true });
  balloons.set(id, balloon); bubbles.append(balloon);
}

function select(id: ProviderId): void {
  selected = id;
  scene?.select(id);
  renderOffice();
}

function statuses(): Record<ProviderId, OfficeStatus> {
  const visible = activityConversation !== undefined && activityConversation === state.current?.meta.id;
  return Object.fromEntries(PROVIDERS.map((id) => [id, officeStatus(provider(id),
    state.config.lead.provider === id || (canLead(state.config.lead.provider) && state.config.team[id].enabled), visible ? activities[id] : undefined)])) as Record<ProviderId, OfficeStatus>;
}

export function renderOffice(): void {
  if (!enabled) return;
  const values = statuses();
  const texts: Partial<Record<ProviderId, string>> = {};
  const now = Date.now();
  let nextExpiry = Infinity;
  for (const id of PROVIDERS) {
    const status = values[id];
    if (lastStatuses[id] !== status) { lastStatuses[id] = status; expires[id] = ['done', 'cancelled'].includes(status) ? now + 4500 : undefined; }
    const expiry = expires[id];
    if (expiry && expiry > now) nextExpiry = Math.min(nextExpiry, expiry);
    texts[id] = expiry && expiry <= now ? '' : notes[id] && ['thinking', 'consulting', 'reviewing', 'writing'].includes(status) ? notes[id] : ACTIVITY_BUBBLES[status] ?? '';
  }
  clearTimeout(bubbleTimer);
  if (nextExpiry !== Infinity) bubbleTimer = setTimeout(renderOffice, Math.max(1, nextExpiry - now));
  const view = JSON.stringify([values, texts, failures, selected, state.config.lead.provider, !!state.run]);
  if (view === lastView) return;
  lastView = view;
  scene?.update(values);
  for (const id of PROVIDERS) {
    const card = cards.get(id)!;
    card.dataset.status = values[id];
    card.setAttribute('aria-pressed', String(id === selected));
    card.title = values[id] === 'error' ? failures[id] ?? 'Ver detalhes da execução' : '';
    badges.get(id)!.textContent = STATUS_LABELS[values[id]];
    const balloon = balloons.get(id)!;
    balloon.hidden = !texts[id];
    balloon.dataset.status = values[id];
    balloon.replaceChildren(h('span', {}, texts[id]),
      ['done', 'error', 'limited', 'cancelled'].includes(values[id]) ? '' : h('span', { class: 'office-dots' }, h('i'), h('i'), h('i')));
  }
  const p = provider(selected);
  const failedRun = values[selected] === 'error' ? activityRunId : undefined;
  detail.replaceChildren(
    h('span', { class: `office-dot ${selected}`, 'aria-hidden': 'true' }),
    h('div', { class: 'grow' }, h('b', {}, NAMES[selected]),
      h('p', { class: 'muted small' }, `${state.config.lead.provider === selected ? 'Líder da conversa' : 'Colega da equipe'} · ${STATUS_LABELS[values[selected]]}`),
      failedRun && failures[selected] ? h('p', { class: 'muted small' }, failures[selected]!) : ''),
    failedRun ? h('button', { type: 'button', class: 'btn text', onClick: () => showRunActivity(failedRun) }, 'Ver detalhes') : '',
    h('button', { type: 'button', class: 'btn tonal', disabled: !!state.run || !p?.available || p.signedIn === false,
      onClick: () => {
        if (state.config.lead.provider !== selected) {
          state.config.lead = { provider: selected };
          saveConfig();
          ctx.renderComposer();
        }
        ctx.focusComposer();
        renderOffice();
      } }, state.config.lead.provider === selected ? 'Conversar' : 'Escolher como líder'),
  );
}

export function startOfficeRun(conversationId: string, runId: string, lead = state.config.lead.provider): void {
  activities = {};
  for (const id of PROVIDERS) { delete notes[id]; delete failures[id]; delete lastStatuses[id]; delete expires[id]; }
  activities[lead] = 'thinking';
  activityConversation = conversationId;
  activityRunId = runId;
  renderOffice();
}

export function onOfficeEvent(event: AppEvent): void {
  activities = nextActivities(activities, event);
  if (event.type === 'peer_activity') {
    notes[event.self] = `Consultando ${NAMES[event.peer]}…`;
    notes[event.peer] = event.activity === 'writing' ? `Respondendo a ${NAMES[event.self]}…` : `Analisando a consulta de ${NAMES[event.self]}…`;
    if (event.activity === 'error') failures[event.peer] = peerFailureDetail(event.failure);
    else delete failures[event.peer];
  } else if (event.type === 'room' && event.event.type === 'turn_end') {
    const turn = event.event;
    delete notes[turn.provider];
    if (turn.status === 'error' && turn.error) failures[turn.provider] = turn.error.slice(0, 320);
    else delete failures[turn.provider];
  } else if (event.type === 'room' && event.event.type === 'tool_result') {
    notes[event.event.provider] = event.event.isError ? 'A ferramenta retornou um problema. Vou conferir…' : 'Ferramenta concluída. Conferindo o resultado…';
  } else if (event.type === 'room' && ['text', 'turn_start', 'tool_call'].includes(event.event.type)) {
    delete notes[event.event.provider];
  } else if (event.type === 'run_done') for (const id of PROVIDERS) delete notes[id];
  renderOffice();
}

async function syncOffice(): Promise<void> {
  const wanted = appearance.office3d === true;
  if (wanted === enabled) { scene?.setReducedMotion(reducedMotion()); return; }
  enabled = wanted;
  officeEl.hidden = !wanted;
  const ticket = ++generation;
  if (!wanted) {
    clearTimeout(bubbleTimer);
    scene?.dispose();
    scene = undefined;
    return;
  }
  failed = false;
  lastView = '';
  viewport.classList.remove('office-ready');
  viewport.classList.remove('office-failed');
  message.hidden = false;
  message.replaceChildren(h('span', {}, 'Acendendo as luzes…'), h('span', { class: 'office-dots' }, h('i'), h('i'), h('i')));
  renderOffice();
  try {
    const { createOfficeScene } = await import('./office-scene.js');
    if (ticket !== generation) return;
    scene = createOfficeScene(viewport, {
      onSelect: select,
      onPosition: (id, x, y) => { const card = cards.get(id)!; card.style.left = `${x}%`; card.style.top = `${y}%`; },
      onBubblePosition: (id, x, y) => { const bubble = balloons.get(id)!; bubble.style.left = `${Math.max(12, Math.min(88, x))}%`; bubble.style.top = `${Math.max(15, y)}%`; },
      onError: showFailure,
    });
    scene.setReducedMotion(reducedMotion());
    scene.setWardrobe(wardrobe);
    officeEl.dataset.room = wardrobe.room;
    scene.select(selected);
    message.hidden = true;
    viewport.classList.add('office-ready');
    lastView = '';
    renderOffice();
  } catch { if (ticket === generation) showFailure(); }
}

function reducedMotion(): boolean { return appearance.reduceMotion || motionQuery.matches; }
const motionQuery = matchMedia('(prefers-reduced-motion: reduce)');

function showFailure(): void {
  if (failed) return;
  failed = true;
  scene?.dispose();
  scene = undefined;
  viewport.classList.add('office-failed');
  message.hidden = false;
  message.replaceChildren('Não foi possível abrir o 3D neste dispositivo. O chat continua disponível.',
    h('button', { class: 'btn', type: 'button', onClick: () => setAppearance({ office3d: false }) }, 'Voltar ao chat'));
}

export function initOffice(): void {
  selected = state.config.lead.provider;
  window.addEventListener('aio:appearance', () => void syncOffice());
  motionQuery.addEventListener('change', () => scene?.setReducedMotion(reducedMotion()));
  window.addEventListener('pagehide', () => { generation++; clearTimeout(bubbleTimer); scene?.dispose(); scene = undefined; enabled = false; });
  void syncOffice();
}
