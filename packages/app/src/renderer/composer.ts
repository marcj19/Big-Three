import { ATTACHMENT_COUNT_LIMIT, ATTACHMENT_FILE_LIMIT, ATTACHMENT_TOTAL_LIMIT, type Access, type AttachmentUpload, type ProviderId } from '../shared/api.js';
import { api } from './bridge.js';
import { messagesEl } from './chat.js';
import { ctx } from './ctx.js';
import { clear, h } from './dom.js';
import { engineMark, icon, providerMark } from './icons.js';
import { segmented } from './seg.js';
import { renderOffice } from './office.js';
import { ACCESS_META, canLead, conversationAccess, modelLabel, NAMES, PROVIDERS, provider, ready, saveConfig, state, teamMembers, usable, type Pick } from './state.js';
import { toast } from './ui.js';

const CUSTOM = '__custom__';
const EFFORT_LABEL: Record<string, string> = { low: 'Baixo', medium: 'Médio', high: 'Alto', xhigh: 'Muito alto', max: 'Máximo' };
const drafts = new Map<string, File[]>();
export const draftKey = (): string => state.current?.meta.id ?? '';
export const draftFiles = (key = draftKey()): File[] => drafts.get(key) ?? [];
export function clearDraftFiles(key: string): void { drafts.delete(key); }

export function encodeAttachment(file: File): Promise<AttachmentUpload> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error(`Não foi possível ler ${file.name}.`));
    reader.onload = () => resolve({ name: file.name, data: (reader.result as string).split(',', 2)[1]! });
    reader.readAsDataURL(file);
  });
}

function addFiles(files: File[]): void {
  if (state.sending || !files.length) return;
  const key = draftKey();
  const next = [...draftFiles(key), ...files];
  if (next.length > ATTACHMENT_COUNT_LIMIT || next.some((file) => file.size > ATTACHMENT_FILE_LIMIT)
    || next.reduce((size, file) => size + file.size, 0) > ATTACHMENT_TOTAL_LIMIT) {
    toast('Envie até 8 arquivos, com até 10 MB por arquivo e 25 MB no total.', 'error');
    return;
  }
  drafts.set(key, next);
  renderAttachments();
}

// ---------- the text field ----------

export const promptEl = h('textarea', {
  rows: '1',
  'aria-label': 'Mensagem',
  placeholder: 'Pergunte ou peça qualquer coisa…',
  onInput: () => {
    autosize();
    updateSend();
  },
  onPaste: (event: ClipboardEvent) => {
    const clipboard = event.clipboardData;
    const files = Array.from(clipboard?.files ?? []);
    if (!files.length) for (const item of Array.from(clipboard?.items ?? [])) {
      const file = item.getAsFile();
      if (file) files.push(file);
    }
    if (!files.length) return;
    event.preventDefault();
    addFiles(files);
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
const sendBtn = h('button', { class: 'send idle', type: 'button', 'aria-label': 'Enviar', title: 'Enviar (Enter)', onClick: () => {
  promptEl.focus();
  void ctx.send();
} }, icon('send'));
const stopBtn = h('button', { class: 'send stop', type: 'button', 'aria-label': 'Parar', title: 'Parar', hidden: true,
  onClick: () => { if (state.run) void ctx.stopRun(state.run.runId); } }, icon('stop'));
function updateSend(): void {
  const run = state.run;
  const visible = !run && (promptEl.value.trim().length > 0 || draftFiles().length > 0);
  sendBtn.hidden = !!run;
  stopBtn.hidden = !run;
  stopBtn.disabled = !!run?.stopping;
  stopBtn.setAttribute('aria-label', run?.stopping ? 'Parando execução' : 'Parar');
  stopBtn.title = run?.stopping ? 'Parando execução…' : 'Parar';
  sendBtn.disabled = state.sending || state.accessChanging;
  sendBtn.classList.toggle('idle', !visible);
  sendBtn.tabIndex = visible ? 0 : -1;
  sendBtn.setAttribute('aria-hidden', String(!visible));
}

// ---------- layout ----------

const filePicker = h('input', { type: 'file', multiple: true, hidden: true, onChange: () => {
  addFiles(Array.from(filePicker.files ?? []));
  filePicker.value = '';
} });
const attachBtn = h('button', { class: 'icon-btn attach-btn', type: 'button', 'aria-label': 'Anexar arquivos', title: 'Anexar arquivos',
  onClick: () => filePicker.click() }, icon('plus'));
const attachmentList = h('div', { class: 'attachment-list', 'aria-label': 'Arquivos para enviar', hidden: true });

function renderAttachments(): void {
  const key = draftKey();
  const files = draftFiles(key);
  attachBtn.disabled = state.sending;
  attachmentList.hidden = !files.length;
  attachmentList.replaceChildren(...files.map((file, index) => h('span', { class: 'attachment-chip', title: file.name },
    icon('file', 'sm'), h('span', {}, file.name),
    h('button', { class: 'icon-btn', type: 'button', disabled: state.sending, 'aria-label': `Remover ${file.name}`, onClick: () => {
      const remaining = files.filter((_, i) => i !== index);
      if (remaining.length) drafts.set(key, remaining);
      else clearDraftFiles(key);
      renderAttachments();
    } }, icon('x', 'sm')))));
  updateSend();
}

const chipsEl = h('div', { class: 'chips' });
const warnEl = h('div', { class: 'composer-notices' });
const hintEl = h('span', { class: 'kbd-hint', 'aria-hidden': 'true' }, h('kbd', {}, 'Enter'), ' envia · ', h('kbd', {}, 'Shift+Enter'), ' nova linha');
export const composerEl = h(
  'div',
  { class: 'composer-wrap' },
  h('div', { class: 'composer' }, warnEl, attachmentList,
    h('div', { class: 'field-box', onDragover: (event: DragEvent) => {
      if (event.dataTransfer?.types.includes('Files')) event.preventDefault();
    }, onDrop: (event: DragEvent) => {
      const files = Array.from(event.dataTransfer?.files ?? []);
      if (files.length) { event.preventDefault(); addFiles(files); }
    } }, filePicker, attachBtn, promptEl, sendBtn, stopBtn),
    h('div', { class: 'foot' }, chipsEl, hintEl)),
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
  const list = state.models[p] ?? [{ id: '', label: p === 'codex' ? 'Automático (padrão do Codex)' : 'Padrão da conta' }];
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
        maxlength: 100,
        onInput: (e: Event) => {
          holder.model = (e.target as HTMLInputElement).value.trim();
          holder.customModel = true;
          saveConfig();
        },
      }),
    );
  }
  if (p === 'codex' && state.models.codex && !list.some((option) => option.id)) {
    out.push(h('p', { class: 'muted small' }, 'A lista de modelos da CLI está indisponível. Use Automático ou digite o identificador em Outro.'));
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
      }),
    );
  }
  radioKeys(row);
  return h(
    'div',
    { class: 'pop-body' },
    h('p', { class: 'pop-title' }, 'Com quem você conversa'),
    row,
    h('div', { class: 'controls' }, ...modelControls(c.lead.provider, c.lead, 'Líder', () => { saveConfig(); renderComposer(); })),
    switchRow('Trocar de modelo se atingir o limite', 'Em somente leitura, um colega habilitado na equipe pode assumir se o líder atingir o limite de uso.', () => c.fallback, (v) => (c.fallback = v)),
  );
}

let accessSeg: ReturnType<typeof segmented<Access>> | undefined;
async function changeAccess(level: Access): Promise<void> {
  if (level === conversationAccess() || state.accessChanging || state.sending || (state.run && state.run.conversationId === state.current?.meta.id)) return;
  state.accessChanging = true;
  renderComposer();
  try {
    if (!state.current && !(await ctx.newConversation())) return;
    const id = state.current!.meta.id;
    const granted = await api.setConversationAccess(id, level);
    if (state.current?.meta.id === id) state.current.access = granted;
  } catch (err) {
    const message = (err as Error).message;
    toast(message.includes('not confirmed') ? 'A alteração de acesso não foi confirmada.' : message, 'error');
  } finally {
    state.accessChanging = false;
    renderComposer();
  }
}

function accessPop(): HTMLElement {
  const level = conversationAccess();
  accessSeg ??= segmented<Access>({
    className: 'access',
    label: 'O que o líder pode fazer',
    value: level,
    items: (['read-only', 'edit', 'full'] as const).map((level) => ({ value: level, label: ACCESS_META[level].short, icon: ACCESS_META[level].icon, title: ACCESS_META[level].hint })),
    onChange: (v) => void changeAccess(v),
  });
  accessSeg.set(level);
  return h('div', { class: 'pop-body' }, h('p', { class: 'pop-title' }, 'Acesso nesta conversa'), accessSeg.el,
    h('p', { class: 'muted small' }, ACCESS_META[level].hint),
    h('p', { class: 'muted small' }, 'A escolha fica salva nesta conversa no app desktop. Use este seletor para mudar o acesso.'));
}

function teamPop(): HTMLElement {
  const c = state.config;
  const lead = c.lead.provider;
  const body = h('div', { class: 'pop-body' }, h('p', { class: 'pop-title' }, 'Equipe'));
  body.append(
    h(
      'p',
      { class: 'muted small' },
      'Os modelos e esforços escolhidos aqui são salvos automaticamente. Colegas dão pareceres em somente leitura.',
    ),
  );
  body.append(switchRow('Consultar equipe automaticamente', 'Os colegas selecionados dão um parecer antes da resposta do líder.', () => c.consultTeam, (enabled) => {
    c.consultTeam = enabled;
    renderComposer();
  }));
  if (!c.consultTeam) body.append(h('p', { class: 'muted small' }, canLead(lead)
    ? `${NAMES[lead]} consulta os colegas quando precisa de uma segunda opinião.`
    : 'Ative a consulta automática para usar a equipe com este líder.'));
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
      switchRow(`Consultar o ${NAMES[p]}`, t.enabled ? `Modelo selecionado: ${modelLabel(p, t)}` : 'Adicione este colega à equipe.', () => t.enabled, (v) => { t.enabled = v; renderComposer(); }, off),
    );
    if (t.enabled && !off) block.append(h('div', { class: 'controls' }, ...modelControls(p, t, NAMES[p], () => { saveConfig(); renderComposer(); })));
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
  const access = conversationAccess();
  const teamAvailable = c.consultTeam || canLead(lead);
  const teamText = members.length ? `${c.consultTeam ? 'Equipe automática' : 'Equipe'}: ${members.map((p) => NAMES[p]).join(', ')}` : 'Sem equipe';
  const accessInfo = ACCESS_META[access];
  const accessChip = chip('access', [icon(accessInfo.icon, 'sm'), access === 'full' ? h('span', { class: 'sr-only' }, accessInfo.label) : accessInfo.label],
    accessPop, 'Acesso', access === 'full' ? 'access-full' : access === 'edit' ? 'warn' : '');
  accessChip.title = accessInfo.label;

  for (const child of Array.from(chipsEl.children)) if (child !== pop) child.remove();
  const chips = [
    chip('model', modelContent, modelPop, 'Modelo'),
    accessChip,
    chip('team', [icon('users', 'sm'), teamText], teamPop, 'Equipe', !teamAvailable || !members.length ? 'muted-chip' : ''),
  ];
  const dbs = state.connections.filter((x) => x.hasPassword);
  if (dbs.length) {
    const on = c.connections;
    chips.push(chip('db', [icon('database', 'sm'), on.length ? `Banco: ${on.join(', ')}` : 'Banco'], dbPop, 'Bancos de dados', on.length ? '' : 'muted-chip'));
  }
  chipsEl.prepend(...chips);
}

function renderWarnings(): void {
  clear(warnEl);
  const c = state.config;
  const level = conversationAccess();
  if (level === 'edit') {
    warnEl.append(
      h(
        'div',
        { class: 'warn-line warn', role: 'note' },
        icon('shield', 'sm'),
        h('span', {}, `${ACCESS_META[level].label} nesta conversa. ${ACCESS_META[level].hint}`),
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
  renderChips();
  if (pop) {
    const anchor = open ? chipsEl.querySelector<HTMLElement>(`[data-fk="${open}"]`) : undefined;
    if (anchor) {
      popOwner = anchor;
      anchor.setAttribute('aria-expanded', 'true');
      refreshPop();
    } else closePop();
  }
  renderWarnings();
  renderAttachments();
}

export const focusComposer = (): void => promptEl.focus();
