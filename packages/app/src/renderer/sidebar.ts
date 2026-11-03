import { api } from './bridge.js';
import { openAppearance } from './appearance.js';
import { openConnectionsDialog } from './connections.js';
import { ctx } from './ctx.js';
import { clear, dayGroup, formatTime, h, keepFocus, relativeTime } from './dom.js';
import { appMark, engineMark, icon, providerMark } from './icons.js';
import { NAMES, PROVIDERS, provider, state } from './state.js';
import { confirmDialog, toast } from './ui.js';

export const sidebarEl = h('nav', { class: 'sidebar', 'aria-label': 'Conversas, modelos e bancos de dados' });

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
      h('span', { id: 'models-h' }, 'Modelos'),
      h(
        'button',
        { class: 'icon-btn sm', type: 'button', 'aria-label': 'Verificar modelos de novo', title: 'Verificar de novo', disabled: state.providersLoading, 'data-fk': 'refresh-models', onClick: () => void ctx.refreshProviders() },
        icon('refresh', `sm${state.providersLoading ? ' spin' : ''}`),
      ),
    ),
  );
  for (const id of PROVIDERS) {
    const p = provider(id);
    const st = statusOf(id);
    const off = !p?.available;
    panel.append(
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
    const note = !p ? '' : !p.available ? (p.reason ?? '') : p.signedIn === false && !p.canLogin ? 'Abra o programa uma vez no terminal e entre com a sua conta.' : '';
    if (note) panel.append(h('p', { class: 'prov-note' }, note));
    for (const line of state.loginOutput[id] ?? []) panel.append(h('p', { class: 'prov-note' }, line));
  }
  const usage = Object.entries(state.usage);
  if (usage.length) {
    const lines = usage.map(([id, u]) => {
      const tokens = u.inputTokens + u.outputTokens;
      const win = u.window?.resetsAt ? ` · renova às ${formatTime(new Date(u.window.resetsAt).toISOString())}` : '';
      const limited = u.limitedUntil && u.limitedUntil > Date.now() ? ' · em pausa' : '';
      return `${NAMES[id as keyof typeof NAMES] ?? id}: ${u.turns} turno${u.turns === 1 ? '' : 's'}, ${tokens.toLocaleString('pt-BR')} tokens${win}${limited}`;
    });
    panel.append(h('div', { class: 'usage-line', 'aria-label': 'Uso nesta sessão' }, ...lines.flatMap((l, i) => (i ? [h('br'), l] : [l]))));
  }
  return panel;
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
