import type { Access, ProviderId } from '../shared/api.js';
import { api } from './bridge.js';
import { messagesEl } from './chat.js';
import { ctx } from './ctx.js';
import { clear, h } from './dom.js';
import { engineMark, icon, providerMark } from './icons.js';
import { segmented } from './seg.js';
import { renderOffice } from './office.js';
import { ACCESS_META, canLead, modelLabel, NAMES, PROVIDERS, provider, ready, saveConfig, state, teamMembers, usable, type Pick } from './state.js';

const CUSTOM = '__custom__';
const EFFORT_LABEL: Record<string, string> = { low: 'Baixo', medium: 'Médio', high: 'Alto', xhigh: 'Muito alto', max: 'Máximo' };

// ---------- the text field ----------

export const promptEl = h('textarea', {
  rows: '1',
  'aria-label': 'Mensagem',
  placeholder: 'Pergunte ou peça qualquer coisa…',
  onInput: () => {
    autosize();
    updateSend();
  },
  onKeydown: (e: KeyboardEvent) => {
    // Enter sends, Shift+Enter breaks the line; never while an input method (IME) is composing.
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      void ctx.send();
    }
  },
});

function autosize(): void {
  promptEl.style.height = 'auto';
  promptEl.style.height = `${Math.min(promptEl.scrollHeight, 200)}px`;
}
export function setPrompt(text: string): void {
  promptEl.value = text;
  autosize();
  updateSend();
}

// The send button appears with a spring once there is something to send, like in Messages.
const sendBtn = h('button', { class: 'send idle', type: 'button', onClick: () => (state.run ? void api.cancelRun(state.run.runId) : void ctx.send()) });
let sendMode: 'send' | 'stop' | '' = '';
function updateSend(): void {
  const busy = state.run !== undefined;
  const hasText = promptEl.value.trim().length > 0;
  const wanted = busy ? 'stop' : 'send';
  if (sendMode !== wanted) {
    sendMode = wanted;
    sendBtn.replaceChildren(icon(busy ? 'stop' : 'send'));
    sendBtn.setAttribute('aria-label', busy ? 'Parar' : 'Enviar');
    sendBtn.title = busy ? 'Parar' : 'Enviar (Enter)';
  }
  sendBtn.classList.toggle('stop', busy);
  const visible = busy || hasText;
  sendBtn.disabled = state.sending && !busy;
  sendBtn.classList.toggle('idle', !visible);
  sendBtn.tabIndex = visible ? 0 : -1;
  sendBtn.setAttribute('aria-hidden', String(!visible));
}

// ---------- layout ----------

const chipsEl = h('div', { class: 'chips' });
const warnEl = h('div', {});
const hintEl = h('span', { class: 'kbd-hint', 'aria-hidden': 'true' }, h('kbd', {}, 'Enter'), ' envia · ', h('kbd', {}, 'Shift+Enter'), ' nova linha');
export const composerEl = h(
  'div',
  { class: 'composer-wrap' },
  h('div', { class: 'composer' }, warnEl, h('div', { class: 'field-box' }, promptEl, sendBtn), h('div', { class: 'foot' }, chipsEl, hintEl)),
);

// Messages scroll beneath the composer, so they need to know how tall it is.
new ResizeObserver(() => {
  const main = composerEl.parentElement;
  if (!main) return;
  const wasAtEnd = messagesEl.scrollHeight - messagesEl.scrollTop - messagesEl.clientHeight < 60;
  main.style.setProperty('--composer-h', `${composerEl.offsetHeight}px`);
  if (wasAtEnd) messagesEl.scrollTop = messagesEl.scrollHeight;
}).observe(composerEl);

// ---------- popovers ----------

let pop: HTMLElement | undefined;
let popOwner: HTMLElement | undefined;
let popBuild: (() => HTMLElement) | undefined;

function closePop(): void {
  pop?.remove();
  pop = undefined;
  popBuild = undefined;
  popOwner?.setAttribute('aria-expanded', 'false');
  popOwner = undefined;
  document.removeEventListener('mousedown', outside, true);
  document.removeEventListener('keydown', onPopKey, true);
}
const outside = (e: MouseEvent) => {
  if (pop && !pop.contains(e.target as Node) && !popOwner?.contains(e.target as Node)) closePop();
};
const onPopKey = (e: KeyboardEvent) => {
  if (e.key === 'Escape') {
    e.stopPropagation();
    const owner = popOwner;
    closePop();
    owner?.focus();
  }
};

/** Opens (or closes, if it is already open) the popover of a chip. `build` is called again to refresh it in place. */
function togglePop(owner: HTMLElement, label: string, build: () => HTMLElement): void {
  if (pop && popOwner === owner) return closePop();
  closePop();
  popBuild = build;
  popOwner = owner;
  pop = h('div', { class: 'pop', role: 'dialog', 'aria-label': label });
  pop.append(build());
  owner.setAttribute('aria-expanded', 'true');
  chipsEl.append(pop);
  pop.style.left = `${Math.min(owner.offsetLeft, Math.max(0, chipsEl.clientWidth - 360))}px`;
  document.addEventListener('mousedown', outside, true);
  document.addEventListener('keydown', onPopKey, true);
  pop.querySelector<HTMLElement>('select, button, input')?.focus();
}

/** Rebuilds the open popover's content, keeping keyboard focus on the same kind of control. */
function refreshPop(): void {
  if (!pop || !popBuild) return;
  const active = document.activeElement;
  const spot = active instanceof HTMLElement && pop.contains(active) ? Array.from(pop.querySelectorAll('select, input, button')).indexOf(active) : -1;
  pop.replaceChildren(popBuild());
  if (spot >= 0) pop.querySelectorAll<HTMLElement>('select, input, button')[spot]?.focus({ preventScroll: true });
}

// ---------- building blocks ----------

const select = (label: string, value: string, options: { value: string; label: string }[], onChange: (v: string) => void) =>
  h(
    'select',
    { class: 'sel', 'aria-label': label, onChange: (e: Event) => onChange((e.target as HTMLSelectElement).value) },
    ...options.map((o) => h('option', { value: o.value, selected: o.value === value }, o.label)),
  );

/** Model, and effort where the CLI takes one, for one provider. `holder` is what is being edited. */
function modelControls(p: ProviderId, holder: Pick, label: string, onChange: () => void): HTMLElement[] {
  const list = state.models[p] ?? [{ id: '', label: 'Padrão da conta' }];
  const custom = holder.customModel === true || (!!holder.model && !list.some((o) => o.id === holder.model));
  const out: HTMLElement[] = [
    select(
      `${label}: modelo de ${NAMES[p]}`,
      custom ? CUSTOM : (holder.model ?? ''),
      [...list.map((o) => ({ value: o.id, label: o.note ? `${o.label} · ${o.note}` : o.label })), { value: CUSTOM, label: 'Outro…' }],
      (v) => {
        holder.customModel = v === CUSTOM;
        holder.model = v === CUSTOM ? '' : v;
        onChange();
      },
    ),
  ];
  if (custom) {
    out.push(
      h('input', {
        class: 'sel-input',
        value: holder.model ?? '',
        placeholder: 'nome do modelo',
        'aria-label': `${label}: nome do modelo de ${NAMES[p]}`,
        spellcheck: 'false',
        autocomplete: 'off',
        onChange: (e: Event) => {
          holder.model = (e.target as HTMLInputElement).value.trim();
          holder.customModel = true;
          onChange();
        },
      }),
    );
  }
  const efforts = provider(p)?.efforts ?? [];
  if (efforts.length) {
    out.push(
      select(
        `${label}: esforço de ${NAMES[p]}`,
        holder.effort ?? '',
        [{ value: '', label: 'Esforço padrão' }, ...efforts.map((e) => ({ value: e, label: EFFORT_LABEL[e] ?? e }))],
        (v) => {
          holder.effort = v;
          onChange();
        },
      ),
    );
  }
  return out;
}

function avatarBtn(id: ProviderId, on: boolean, onClick: () => void): HTMLButtonElement {
  const off = !usable(id);
  const reason = off ? `${NAMES[id]} não está instalado` : provider(id)?.signedIn === false ? `${NAMES[id]} não está conectado` : NAMES[id];
  return h(
    'button',
    { type: 'button', class: 'pick-btn', role: 'radio', 'aria-checked': String(on), tabindex: on ? undefined : '-1', 'aria-label': reason, title: reason, disabled: off, onClick },
    h('span', { class: `avatar${off ? ' off' : ''}` }, providerMark(id)),
    h('span', { class: 'lbl' }, NAMES[id]),
  );
}

function radioKeys(group: HTMLElement): void {
  group.addEventListener('keydown', (e) => {
    const forward = e.key === 'ArrowRight' || e.key === 'ArrowDown';
    if (!forward && e.key !== 'ArrowLeft' && e.key !== 'ArrowUp') return;
    const radios = Array.from(group.querySelectorAll<HTMLButtonElement>('[role=radio]:not(:disabled)'));
    const at = radios.indexOf(document.activeElement as HTMLButtonElement);
    if (at < 0) return;
    e.preventDefault();
    const next = radios[(at + (forward ? 1 : -1) + radios.length) % radios.length]!;
    next.focus();
    next.click();
  });
}

function switchRow(label: string, hint: string, get: () => boolean, set: (v: boolean) => void, disabled = false): HTMLElement {
  const id = `sw-${label.replace(/\W+/g, '')}-${Math.random().toString(36).slice(2, 6)}`;
  const sw = h('button', { type: 'button', class: 'switch', role: 'switch', 'aria-checked': String(get()), 'aria-labelledby': id, 'aria-describedby': `${id}-d`, disabled });
  const flip = () => {
    if (disabled) return;
    set(!get());
    sw.setAttribute('aria-checked', String(get()));
    saveConfig();
  };
  sw.addEventListener('click', (e) => {
    e.stopPropagation();
    flip();
  });
  return h('div', { class: `switch-row${disabled ? ' off' : ''}`, onClick: flip }, h('span', {}, h('span', { id }, label), h('small', { id: `${id}-d` }, hint)), sw);
}

// ---------- the chips and what they open ----------

function chip(kind: string, content: (Node | string)[], build: () => HTMLElement, label: string, tone = ''): HTMLElement {
  const btn = h('button', { type: 'button', class: `chip-btn ${tone}`.trim(), 'aria-haspopup': 'dialog', 'aria-expanded': 'false', 'data-fk': `chip-${kind}` }, ...content, icon('chevron', 'sm'));
  btn.addEventListener('click', () => togglePop(btn, label, build));
  btn.setAttribute('aria-label', `${label}: ${btn.textContent?.trim() ?? ''}`);
  return btn;
}

function modelPop(): HTMLElement {
  const c = state.config;
  const row = h('div', { class: 'pick-row', role: 'radiogroup', 'aria-label': 'Quem conversa com você' });
  for (const p of PROVIDERS) {
    row.append(
      avatarBtn(p, c.lead.provider === p, () => {
        if (c.lead.provider === p) return;
        c.lead = { provider: p };
        saveConfig();
        renderComposer();
        refreshPop();
      }),
    );
  }
  radioKeys(row);
  return h(
    'div',
    { class: 'pop-body' },
    h('p', { class: 'pop-title' }, 'Com quem você conversa'),
    row,
    h('div', { class: 'controls' }, ...modelControls(c.lead.provider, c.lead, 'Líder', () => { saveConfig(); renderComposer(); refreshPop(); })),
    switchRow('Trocar de modelo se atingir o limite', 'Só quando o líder está em somente leitura. Se pode editar arquivos, ele não é trocado.', () => c.fallback, (v) => (c.fallback = v)),
  );
}

let accessSeg: ReturnType<typeof segmented<Access>> | undefined;
function accessPop(): HTMLElement {
  const c = state.config;
  accessSeg ??= segmented<Access>({
    className: 'access',
    label: 'O que o líder pode fazer',
    value: c.access,
    items: (['read-only', 'edit', 'full'] as const).map((level) => ({ value: level, label: ACCESS_META[level].short, icon: ACCESS_META[level].icon, title: ACCESS_META[level].hint })),
    onChange: (v) => {
      c.access = v;
      accessSeg!.set(v);
      renderComposer();
      const hint = pop?.querySelector('.access-hint');
      if (hint) hint.textContent = ACCESS_META[v].hint;
    },
  });
  accessSeg.set(c.access);
  return h('div', { class: 'pop-body' }, h('p', { class: 'pop-title' }, 'O que o líder pode fazer'), accessSeg.el, h('p', { class: 'access-hint muted small' }, ACCESS_META[c.access].hint), h('p', { class: 'muted small' }, 'Mudar arquivos sempre pede a sua confirmação antes de começar.'));
}

function teamPop(): HTMLElement {
  const c = state.config;
  const lead = c.lead.provider;
  const body = h('div', { class: 'pop-body' }, h('p', { class: 'pop-title' }, 'Equipe'));
  body.append(
    h(
      'p',
      { class: 'muted small' },
      `${NAMES[lead]} decide sozinho se precisa consultar um colega, ou você pede no chat ("peça ao Gemini para revisar"). Colegas só leem e respondem; quem altera arquivos é o líder.`,
    ),
  );
  if (!canLead(lead)) {
    body.append(h('div', { class: 'warn-line info', role: 'note' }, icon('info', 'sm'), h('span', {}, `${NAMES[lead]} ainda não consegue chamar colegas. Escolha Claude ou Codex como líder para usar a equipe; eles podem consultar o ${NAMES[lead]}.`)));
  }
  for (const p of PROVIDERS.filter((x) => x !== lead)) {
    const t = c.team[p];
    const off = !ready(p);
    const block = h('div', { class: 'member-block' });
    block.append(
      h(
        'div',
        { class: 'member-head' },
        h('span', { class: `avatar sm${off ? ' off' : ''}` }, providerMark(p)),
        h('b', {}, NAMES[p]),
        off ? h('span', { class: 'muted small' }, usable(p) ? 'não conectado' : 'não instalado') : '',
      ),
      switchRow(`Consultar o ${NAMES[p]}`, 'O líder pode fazer perguntas a ele.', () => t.enabled, (v) => { t.enabled = v; renderComposer(); refreshPop(); }, off || !canLead(lead)),
    );
    if (t.enabled && !off) block.append(h('div', { class: 'controls' }, ...modelControls(p, t, NAMES[p], () => { saveConfig(); renderComposer(); refreshPop(); })));
    body.append(block);
  }
  return body;
}

function dbPop(): HTMLElement {
  const c = state.config;
  const body = h('div', { class: 'pop-body' }, h('p', { class: 'pop-title' }, 'Bancos de dados (só leitura)'));
  const group = h('div', { class: 'db-list' });
  for (const x of state.connections.filter((v) => v.hasPassword)) {
    const on = c.connections.includes(x.name);
    group.append(
      h(
        'button',
        {
          type: 'button',
          class: 'db-chip',
          'aria-pressed': String(on),
          onClick: () => {
            c.connections = on ? c.connections.filter((n) => n !== x.name) : [...c.connections, x.name];
            renderComposer();
            refreshPop();
          },
        },
        h('span', { class: 'tile' }, engineMark(x.engine)),
        x.name,
      ),
    );
  }
  body.append(group, h('p', { class: 'muted small' }, 'Os modelos só conseguem fazer consultas SELECT. A senha nunca passa por eles.'));
  return body;
}

function renderChips(): void {
  const c = state.config;
  const lead = c.lead.provider;
  const parts = [modelLabel(lead, c.lead), c.lead.effort ? EFFORT_LABEL[c.lead.effort] : ''].filter((x) => x && x !== 'Padrão');
  const modelContent: (Node | string)[] = [h('span', { class: 'avatar xs' }, providerMark(lead)), `${NAMES[lead]}${parts.length ? ` · ${parts.join(' · ')}` : ''}`];

  const members = teamMembers(c);
  const teamText = !canLead(lead) ? 'Equipe indisponível' : members.length ? `Equipe: ${members.map((p) => NAMES[p]).join(', ')}` : 'Sem equipe';

  clear(chipsEl);
  chipsEl.append(
    chip('model', modelContent, modelPop, 'Modelo'),
    chip('access', [icon(ACCESS_META[c.access].icon, 'sm'), ACCESS_META[c.access].label], accessPop, 'Acesso', c.access === 'edit' ? 'warn' : c.access === 'full' ? 'danger' : ''),
    chip('team', [icon('users', 'sm'), teamText], teamPop, 'Equipe', !canLead(lead) || !members.length ? 'muted-chip' : ''),
  );
  const dbs = state.connections.filter((x) => x.hasPassword);
  if (dbs.length) {
    const on = c.connections;
    chipsEl.append(chip('db', [icon('database', 'sm'), on.length ? `Banco: ${on.join(', ')}` : 'Banco'], dbPop, 'Bancos de dados', on.length ? '' : 'muted-chip'));
  }
}

function renderWarnings(): void {
  clear(warnEl);
  const c = state.config;
  if (c.access !== 'read-only') {
    warnEl.append(
      h(
        'div',
        { class: `warn-line ${c.access === 'full' ? 'danger' : 'warn'}`, role: 'note' },
        icon('shield', 'sm'),
        h('span', {}, `${ACCESS_META[c.access].label}: ${ACCESS_META[c.access].hint} O app vai pedir a sua confirmação antes de começar.`),
      ),
    );
  }
  const noMcp = c.connections.length ? PROVIDERS.filter((p) => provider(p) && !provider(p)!.supportsMcp) : [];
  if (noMcp.includes(c.lead.provider)) {
    warnEl.append(h('div', { class: 'warn-line info', role: 'note' }, icon('info', 'sm'), h('span', {}, `${NAMES[c.lead.provider]} ainda não consegue consultar o banco. Escolha Claude ou Codex como líder.`)));
  }
}

export function renderComposer(): void {
  renderOffice();
  const awaitingAnswer = state.run?.conversationId === state.current?.meta.id && !!state.run?.questions.length;
  promptEl.readOnly = awaitingAnswer;
  promptEl.placeholder = awaitingAnswer ? 'Responda à pergunta no topo do chat…' : 'Pergunte ou peça qualquer coisa…';
  const open = pop ? popOwner?.dataset.fk : undefined;
  if (pop) {
    // keep the open popover's DOM across the re-render of the chips
    pop.remove();
  }
  renderChips();
  if (pop) {
    chipsEl.append(pop);
    const anchor = open ? chipsEl.querySelector<HTMLElement>(`[data-fk="${open}"]`) : undefined;
    if (anchor) {
      popOwner = anchor;
      anchor.setAttribute('aria-expanded', 'true');
    }
  }
  renderWarnings();
  updateSend();
}

export const focusComposer = (): void => promptEl.focus();
