import type { ProviderId } from '../shared/api.js';
import { api } from './bridge.js';
import { openAppearance } from './appearance.js';
import { openConnectionsDialog } from './connections.js';
import { ctx } from './ctx.js';
import { clear, dayGroup, h, keepFocus, relativeTime } from './dom.js';
import { appMark, engineMark, icon, providerMark } from './icons.js';
import { NAMES, PROVIDERS, provider, state } from './state.js';
import { confirmDialog, toast } from './ui.js';
import { openQuotas } from './quotas.js';
import { meterOf } from './quota-format.js';

export const sidebarEl = h('nav', { class: 'sidebar', 'aria-label': 'Conversas, modelos e bancos de dados' });
let modelsCollapsed = false;
try { modelsCollapsed = localStorage.getItem('aio.models.collapsed') === 'true'; } catch { /* defaults */ }

function statusOf(id: (typeof PROVIDERS)[number]): { text: string; cls: string; ic: 'check' | 'alert' | 'info' } {
  const p = provider(id);
  if (!p) return { text: 'Verificando…', cls: '', ic: 'info' };
  if (!p.available) return { text: 'Não instalado', cls: 'bad', ic: 'alert' };
  if (p.signedIn === true) return { text: 'Conectado', cls: 'ok', ic: 'check' };
  if (p.signedIn === false) return { text: 'Desconectado', cls: 'bad', ic: 'alert' };
  return { text: 'Instalado', cls: 'unknown', ic: 'info' };
}

function conversationList(): HTMLElement {
  const wrap = h('div', { class: 'scroll' });
  if (!state.conversations.length) {
    wrap.append(h('p', { class: 'empty-note' }, 'Nenhuma conversa ainda. Crie a primeira acima.'));
    return wrap;
  }
  let last = '';
  let list: HTMLElement | undefined;
  for (const c of state.conversations) {
    const group = dayGroup(c.updatedAt);
    if (group !== last) {
      last = group;
      wrap.append(h('div', { class: 'group-title', role: 'presentation' }, group));
      list = h('ul', { class: 'conv-list', 'aria-label': group });
      wrap.append(list);
    }
    const active = state.current?.meta.id === c.id;
    list!.append(
      h(
        'li',
        { class: 'conv', 'aria-current': active ? 'true' : undefined },
        h('button', { class: 'conv-main', type: 'button', 'data-fk': `conv-${c.id}`, title: `${c.title} · ${relativeTime(c.updatedAt)}`, onClick: () => void ctx.openConversation(c.id) }, c.title),
        h(
          'button',
          {
            class: 'icon-btn sm del',
            type: 'button',
            'data-fk': `del-${c.id}`,
            'aria-label': `Apagar a conversa ${c.title}`,
            title: 'Apagar',
            onClick: async () => {
              if (!(await confirmDialog({ title: 'Apagar conversa?', message: `"${c.title}" e todo o seu histórico serão removidos deste computador.`, confirm: 'Apagar', danger: true }))) return;
              try {
                await api.deleteConversation(c.id);
              } catch (err) {
                return toast((err as Error).message, 'error');
              }
              if (state.current?.meta.id === c.id) state.current = undefined;
              await ctx.refreshConversations();
              ctx.renderTopbar();
              ctx.renderMessages();
            },
          },
          icon('trash', 'sm'),
        ),
      ),
    );
  }
  return wrap;
}

function modelsPanel(): HTMLElement {
  const panel = h('section', { class: 'panel', 'aria-labelledby': 'models-h' });
  panel.append(
    h(
      'div',
      { class: 'panel-head' },
      h('button', { id: 'models-h', class: 'models-toggle', type: 'button', 'data-fk': 'toggle-models', 'aria-expanded': String(!modelsCollapsed), 'aria-controls': 'models-body',
        title: modelsCollapsed ? 'Expandir modelos' : 'Recolher modelos', onClick: () => {
          modelsCollapsed = !modelsCollapsed;
          try { localStorage.setItem('aio.models.collapsed', String(modelsCollapsed)); } catch { /* storage unavailable */ }
          renderSidebar();
        } }, icon('chevron', `sm${modelsCollapsed ? ' folded' : ''}`), 'Modelos',
        modelsCollapsed ? h('span', { class: 'models-count' }, `${PROVIDERS.filter((id) => provider(id)?.available && provider(id)?.signedIn === true).length} conectados`) : ''),
      h(
        'button',
        { class: 'icon-btn sm', type: 'button', 'aria-label': 'Verificar modelos de novo', title: 'Verificar de novo', disabled: state.providersLoading, 'data-fk': 'refresh-models', onClick: () => void ctx.refreshProviders() },
        icon('refresh', `sm${state.providersLoading ? ' spin' : ''}`),
      ),
    ),
  );
  const body = h('div', { id: 'models-body', hidden: modelsCollapsed });
  panel.append(body);
  for (const id of PROVIDERS) {
    const p = provider(id);
    const st = statusOf(id);
    const off = !p?.available;
    body.append(
      h(
        'div',
        { class: 'prov' },
        h('span', { class: `avatar${off ? ' off' : ''}` }, providerMark(id)),
        h(
          'div',
          { class: 'info' },
          h('div', { class: 'nm' }, p?.displayName ?? NAMES[id]),
          h('div', { class: `st ${st.cls}` }, icon(st.ic, 'sm'), st.text, p?.version && p.available && /\d+\.\d+/.test(p.version) ? h('span', { class: 'muted' }, `· ${/\d+(\.\d+)+/.exec(p.version)![0]}`) : ''),
        ),
        p?.available && p.signedIn !== true && p.canLogin
          ? h('button', { class: 'btn tonal', type: 'button', 'data-fk': `login-${id}`, onClick: () => void api.loginProvider(id).catch((e: Error) => toast(e.message, 'error')) }, 'Entrar')
          : '',
      ),
    );
    if (p?.available) body.append(quotaMeters(id));
    const note = !p ? '' : !p.available ? (p.reason ?? '') : p.signedIn === false && !p.canLogin ? 'Abra o programa uma vez no terminal e entre com a sua conta.' : '';
    if (note) body.append(h('p', { class: 'prov-note' }, note));
    for (const line of state.loginOutput[id] ?? []) body.append(h('p', { class: 'prov-note' }, line));
  }
  const usage = Object.entries(state.usage);
  if (usage.length) {
    const lines = usage.map(([id, u]) => {
      const tokens = u.inputTokens + u.outputTokens;
      const limited = u.limitedUntil && u.limitedUntil > Date.now() ? ' · em pausa' : '';
      return `${NAMES[id as keyof typeof NAMES] ?? id}: ${u.turns} turno${u.turns === 1 ? '' : 's'}, ${tokens.toLocaleString('pt-BR')} tokens${limited}`;
    });
    body.append(h('div', { class: 'usage-line', 'aria-label': 'Uso nesta sessão' }, h('b', {}, 'Uso nesta sessão do app'), h('br'), ...lines.flatMap((l, i) => (i ? [h('br'), l] : [l]))));
  }
  panel.append(h('button', { class: 'btn text block', type: 'button', 'data-fk': 'open-quotas', onClick: openQuotas }, icon('plan', 'sm'), 'Limites e uso'));
  return panel;
}

/** Plan limits under a model: percent used and when the window renews. Empty when the CLI reports nothing. */
function quotaMeters(id: ProviderId): HTMLElement | string {
  const windows = (state.quotas.find((entry) => entry.provider === id)?.windows ?? []).filter((w) => w.usedPercent !== undefined || w.resetsAt !== undefined || w.status !== undefined).slice(0, 3);
  if (!windows.length) return '';
  return h('div', { class: 'qmeters', role: 'group', 'aria-label': `Limites de ${NAMES[id]}` }, ...windows.map((w) => {
    const m = meterOf(w);
    return h('div', { class: 'qm' },
      h('div', { class: 'qm-top' }, h('span', {}, m.label), h('span', { class: `qm-val${m.high ? ' high' : ''}` }, m.text)),
      m.percent !== undefined ? h('progress', { max: 100, value: m.percent, class: m.high ? 'high' : '', 'aria-label': `${m.label}: ${m.text}` }) : '',
      m.reset ? h('div', { class: 'qm-reset' }, m.reset) : '');
  }));
}

function databasesPanel(): HTMLElement {
  const panel = h('section', { class: 'panel', 'aria-labelledby': 'dbs-h' });
  panel.append(h('div', { class: 'panel-head' }, h('span', { id: 'dbs-h' }, 'Bancos de dados')));
  for (const c of state.connections) {
    panel.append(
      h(
        'div',
        { class: 'prov' },
        h('span', { class: 'tile' }, engineMark(c.engine)),
        h('div', { class: 'info' }, h('div', { class: 'nm' }, c.name), h('div', { class: `st ${c.hasPassword ? 'ok' : 'unknown'}` }, icon(c.hasPassword ? 'check' : 'alert', 'sm'), c.hasPassword ? 'Pronto' : 'Falta a senha')),
      ),
    );
  }
  panel.append(
    h(
      'button',
      { class: 'btn text block', type: 'button', 'data-fk': 'manage-dbs', onClick: () => openConnectionsDialog(ctx.refreshConnections) },
      icon(state.connections.length ? 'sliders' : 'plus', 'sm'),
      state.connections.length ? 'Gerenciar' : 'Conectar um banco',
    ),
  );
  return panel;
}

export function renderSidebar(): void {
  keepFocus(sidebarEl, () => {
    clear(sidebarEl);
    sidebarEl.append(
      h(
        'div',
        { class: 'brand' },
        h('span', { class: 'mark' }, appMark()),
        h('span', { class: 'name' }, 'Big Three'),
        h('button', { class: 'icon-btn', type: 'button', 'aria-label': 'Aparência e acessibilidade', title: 'Aparência', 'data-fk': 'appearance', onClick: openAppearance }, icon('sliders')),
      ),
      h('button', { class: 'btn tonal new-btn', type: 'button', 'data-fk': 'new-conv', onClick: () => void ctx.newConversation() }, icon('plus'), 'Nova conversa', h('kbd', { 'aria-hidden': 'true' }, 'Ctrl+N')),
      conversationList(),
      modelsPanel(),
      databasesPanel(),
    );
  });
}
