import type { AppEvent, BrowserState, MessageView, RunRecord, StartRun, WorkspaceDirectory, WorkspaceFile } from '../shared/api.js';
import { newRunRecord, recordWork } from '../shared/work-trace.js';
import { browserUrl } from '../shared/browser-url.js';
import { api } from './bridge.js';
import { ctx } from './ctx.js';
import { formatTime, h, keepFocus, renderRichText } from './dom.js';
import { icon, providerMark } from './icons.js';
import { NAMES, state } from './state.js';
import { toast } from './ui.js';

export type HarnessPanel = 'activity' | 'files' | 'browser';
let panel: HarnessPanel | undefined;
let conversationId: string | undefined;
let records: RunRecord[] = [];
let liveRecord: RunRecord | undefined;
let chosenRun = '';
let signature = '';
let historyTicket = 0;
let wide = false;
let renderedRun = '';
const STATUS = { running: 'Em andamento', ok: 'Concluída', error: 'Com erro', cancelled: 'Cancelada' };
const ENTRY_STATUS = { running: 'Em andamento', done: 'Concluído', error: 'Erro', cancelled: 'Cancelado', skipped: 'Ignorado' };
const fail = (err: unknown) => toast(err instanceof Error ? err.message : String(err), 'error');

const heading = h('h2', {}, 'Atividade');
const activity = h('section', { class: 'harness-page activity-page', 'aria-label': 'Gerenciamento de execuções' });
const files = h('section', { class: 'harness-page files-page', 'aria-label': 'Arquivos do projeto', hidden: true });
const browserPage = h('section', { class: 'harness-page browser-page', 'aria-label': 'Navegador integrado', hidden: true });
export const harnessEl = h('aside', { class: 'harness', 'aria-label': 'Área de trabalho', hidden: true },
  h('header', { class: 'harness-header' }, h('div', {}, h('p', { class: 'harness-eyebrow' }, 'ÁREA DE TRABALHO'), heading),
    h('div', { class: 'harness-controls' },
      h('button', { class: 'btn text', type: 'button', 'aria-label': 'Ampliar ou reduzir painel', onClick: () => {
        wide = !wide; harnessEl.closest('.workbench')?.classList.toggle('panel-wide', wide); scheduleBounds();
      } }, 'Ampliar'),
      h('button', { class: 'icon-btn', type: 'button', 'aria-label': 'Fechar área de trabalho', onClick: () => setPanel(undefined) }, icon('x')))),
  h('div', { class: 'harness-tabs', 'aria-label': 'Painéis' }, ...(['activity', 'files', 'browser'] as const).map((id) => h('button', {
    type: 'button', 'data-panel': id, onClick: () => setPanel(id),
  }, id === 'activity' ? 'Atividade' : id === 'files' ? 'Arquivos' : 'Navegador'))), activity, files, browserPage);

export function harnessToolbar(): HTMLElement {
  return h('div', { class: 'harness-toolbar', 'aria-label': 'Abrir área de trabalho' }, ...([
    ['activity', 'Atividade', 'plan'], ['files', 'Arquivos', 'folder'], ['browser', 'Navegador', 'eye'],
  ] as const).map(([id, label, mark]) => h('button', { class: 'btn', type: 'button', 'aria-pressed': String(panel === id), onClick: () => togglePanel(id) }, icon(mark, 'sm'), h('span', {}, label))));
}
export function togglePanel(value: HarnessPanel): void { setPanel(panel === value ? undefined : value); }
function setPanel(value: HarnessPanel | undefined): void {
  panel = value; harnessEl.hidden = !value;
  harnessEl.closest('.workbench')?.classList.toggle('has-panel', !!value);
  activity.hidden = value !== 'activity'; files.hidden = value !== 'files'; browserPage.hidden = value !== 'browser';
  heading.textContent = value === 'files' ? 'Seu projeto, por dentro.' : value === 'browser' ? 'Explore sem sair daqui.' : 'Acompanhe o trabalho.';
  for (const button of harnessEl.querySelectorAll<HTMLElement>('[data-panel]')) button.setAttribute('aria-pressed', String(button.dataset.panel === value));
  if (!value) { wide = false; harnessEl.closest('.workbench')?.classList.remove('panel-wide'); }
  ctx.renderTopbar(); renderHarness(); scheduleBounds();
  if (value === 'activity') void refreshHistory();
  if (value === 'browser') void api.browserState().then(onBrowserState).catch(fail);
}

export function startHarnessRun(id: string, input: StartRun): void {
  liveRecord = newRunRecord(id, input);
  if (state.current?.meta.id !== input.conversationId) return;
  records = [liveRecord, ...records.filter((record) => record.id !== id)];
  chosenRun = id;
  signature = '';
  renderActivity();
}
export const activeRunRecord = (): RunRecord | undefined => liveRecord;
export function showRunActivity(id: string): void {
  chosenRun = id;
  setPanel('activity');
}
export function loadHarnessConversation(): void { renderHarness(); void refreshHistory(); }
export function conversationRuns(): RunRecord[] { return records; }
export function matchRun(message: MessageView, runs: RunRecord[]): RunRecord | undefined {
  return runs.filter((run) => run.prompt === message.text.slice(0, 400) && Math.abs(Date.parse(run.startedAt) - Date.parse(message.at)) < 30000)
    .sort((a, b) => Math.abs(Date.parse(a.startedAt) - Date.parse(message.at)) - Math.abs(Date.parse(b.startedAt) - Date.parse(message.at)))[0];
}
export function workCard(run: RunRecord, existing?: HTMLElement): HTMLElement {
  const el = existing ?? h('section', { class: 'chat-work-card', 'aria-label': 'Resumo do trabalho da equipe' });
  const last = run.entries.slice().reverse().find((entry) => !['start', 'finish'].includes(entry.kind));
  const waiting = run.entries.some((entry) => entry.kind === 'question' && entry.status === 'running');
  const providers = [...new Set(run.entries.flatMap((entry) => [entry.provider, entry.peer].filter((id): id is NonNullable<typeof id> => !!id)))];
  const counts = [
    [run.entries.filter((entry) => entry.kind === 'tool').length, 'ferramenta', 'ferramentas'],
    [run.entries.filter((entry) => entry.kind === 'consult').length, 'consulta entre IAs', 'consultas entre IAs'],
    [run.entries.filter((entry) => entry.kind === 'subagent').length, 'subagente', 'subagentes'],
  ] as const;
  const summary = counts.filter(([count]) => count > 0).map(([count, single, plural]) => `${count} ${count === 1 ? single : plural}`).join(' · ');
  const key = JSON.stringify([run.status, last, waiting, providers, run.entries.length, run.previewUrl]);
  if (el.dataset.view === key) return el;
  el.dataset.view = key;
  el.replaceChildren(h('div', { class: 'chat-work-head' }, h('span', { class: 'chat-work-avatars' }, ...providers.map((id) => h('span', { class: 'avatar xs', title: NAMES[id] }, providerMark(id)))),
    h('b', {}, run.status === 'running' ? waiting ? 'Aguardando sua resposta' : 'Execução em andamento' : `Execução ${run.status === 'ok' ? 'concluída' : run.status === 'cancelled' ? 'cancelada' : 'com erro'}`)),
    waiting ? '' : h('p', {}, run.status === 'running' ? last?.detail ?? last?.label ?? 'Preparando a tarefa…' : summary),
    h('div', { class: 'chat-work-actions' },
      h('button', { class: 'btn text', type: 'button', onClick: () => showRunActivity(run.id) }, 'Ver etapas e detalhes'),
      run.previewUrl ? h('button', { class: 'btn tonal', type: 'button', onClick: () => openProjectPreview(run.previewUrl!) }, 'Abrir prévia') : ''));
  return el;
}
export function onHarnessEvent(event: AppEvent): void {
  if (event.type === 'browser') return onBrowserState(event.state);
  if (!('runId' in event)) return;
  const record = liveRecord?.id === event.runId ? liveRecord : records.find((record) => record.id === event.runId);
  if (record) recordWork(record, event);
  if (event.type !== 'room' || event.event.type !== 'text') signature = '';
  if (event.type === 'run_done') { void refreshHistory(); void refreshFiles(); }
  renderActivity();
}
async function refreshHistory(): Promise<void> {
  const id = state.current?.meta.id;
  if (!id) return;
  const ticket = ++historyTicket;
  try {
    const history = await api.runHistory(id);
    if (ticket !== historyTicket || state.current?.meta.id !== id) return;
    const active = liveRecord?.conversationId === id && liveRecord.status === 'running' ? liveRecord : undefined;
    records = active ? [active, ...history.filter((record) => record.id !== active.id)] : history;
    signature = '';
    if (!records.some((record) => record.id === chosenRun)) chosenRun = records[0]?.id ?? '';
    renderActivity();
    ctx.renderMessages();
  } catch (err) { if (ticket === historyTicket) fail(err); }
}
function renderActivity(): void {
  if (panel !== 'activity') return;
  const selected = records.find((record) => record.id === chosenRun) ?? records[0];
  const next = JSON.stringify([state.current?.meta.id, state.run?.runId, selected, records.map((r) => [r.id, r.status])]);
  if (next === signature) return;
  signature = next;
  keepFocus(activity, () => {
    const select = h('select', { 'aria-label': 'Execução para acompanhar', 'data-fk': 'run-picker', onChange: () => { chosenRun = select.value; signature = ''; renderActivity(); } },
      ...records.map((run) => h('option', { value: run.id, selected: selected?.id === run.id }, `${formatTime(run.startedAt)} · ${STATUS[run.status]} · ${run.prompt.slice(0, 65)}`)));
    const elsewhere = state.run && state.run.conversationId !== state.current?.meta.id
      ? h('button', { class: 'btn tonal', type: 'button', onClick: () => void ctx.openConversation(state.run!.conversationId) }, 'Ver tarefa em andamento em outra conversa') : '';
    if (!selected) {
      activity.replaceChildren(elsewhere, h('div', { class: 'harness-empty' }, icon('plan'), h('h3', {}, state.current ? 'O trabalho fica registrado aqui.' : 'Escolha uma pasta para começar.'),
        h('p', {}, state.current ? 'Envie uma tarefa. Você verá as etapas, ferramentas e consultas entre as IAs em uma linha do tempo.' : 'Crie uma conversa para acompanhar tarefas e explorar o projeto.')));
      return;
    }
    const tokenCount = selected.inputTokens + selected.outputTokens;
    const elapsed = Math.max(0, Math.round((Date.parse(selected.endedAt ?? new Date().toISOString()) - Date.parse(selected.startedAt)) / 1000));
    const cancel = selected.status === 'running' ? h('button', { class: 'btn danger', type: 'button', onClick: () => void api.cancelRun(selected.id).catch(fail) }, 'Parar execução') : '';
    const scroll = activity.scrollTop;
    const sameRun = renderedRun === selected.id;
    const open = new Set([...activity.querySelectorAll<HTMLElement>('details[open]')].map((el) => el.dataset.entry));
    renderedRun = selected.id;
    activity.replaceChildren(elsewhere,
      h('div', { class: 'run-picker' }, select),
      h('section', { class: `run-overview ${selected.status}` },
        h('div', { class: 'run-overview-top' }, h('span', { class: 'run-badge' }, STATUS[selected.status]), cancel),
        h('p', { class: 'run-prompt' }, selected.prompt),
        h('div', { class: 'run-stats' }, h('span', { 'data-elapsed': selected.id }, `${elapsed}s${selected.status === 'running' ? ' até agora' : ''}`), h('span', {}, `${tokenCount.toLocaleString('pt-BR')} tokens reportados`), h('span', {}, `${selected.entries.filter((e) => e.kind === 'consult').length} consultas`))),
      h('ol', { class: 'work-timeline', 'aria-label': 'Linha do tempo da execução' }, ...selected.entries.map((entry) => h('li', { class: `work-entry work-${entry.kind} ${entry.status}` },
        h('span', { class: 'work-node', 'aria-hidden': 'true' }, entry.provider ? providerMark(entry.provider) : icon(entry.status === 'error' ? 'alert' : 'check', 'sm')),
        h('div', { class: 'work-copy' }, h('div', { class: 'work-title' }, h('b', {}, entry.label), h('span', { class: 'work-time' }, formatTime(entry.at))),
          h('div', { class: 'work-meta' }, entry.provider ? NAMES[entry.provider] : 'Orquestrador', ' · ', ENTRY_STATUS[entry.status]),
          entry.detail ? h('p', { class: 'work-detail' }, entry.detail) : '',
          entry.tool ? h('details', { 'data-entry': String(entry.id), open: sameRun && open.has(String(entry.id)) }, h('summary', {}, 'Detalhes da ferramenta'), h('code', {}, entry.tool)) : '')))));
    activity.scrollTop = sameRun ? scroll : 0;
  });
}

// ---------- project files ----------
const directories = new Map<string, WorkspaceDirectory>();
const expanded = new Set<string>(['']);
const loadingDirectories = new Set<string>();
let currentFile: WorkspaceFile | undefined;
let fileTicket = 0;
let directoryError = '';
const fileTree = h('div', { class: 'file-tree', 'aria-label': 'Estrutura de arquivos' });
const filePreview = h('div', { class: 'file-preview' });
const filter = h('input', { type: 'search', placeholder: 'Filtrar pastas abertas…', 'aria-label': 'Filtrar arquivos nas pastas abertas', onInput: () => renderFiles() });
const rootLabel = h('p', { class: 'file-root' });
files.append(h('div', { class: 'files-toolbar' }, rootLabel, h('button', { class: 'btn', type: 'button', onClick: () => void refreshFiles() }, 'Atualizar')), filter,
  h('div', { class: 'files-layout' }, fileTree, filePreview));
async function loadDirectory(relative: string): Promise<void> {
  const id = state.current?.meta.id;
  if (!id || loadingDirectories.has(relative)) return;
  loadingDirectories.add(relative);
  try {
    const data = await api.workspaceDirectory(id, relative);
    if (state.current?.meta.id !== id) return;
    directories.set(relative, data); directoryError = ''; renderFiles();
  } catch (err) { if (state.current?.meta.id === id) { directoryError = (err as Error).message; renderFiles(); } }
  finally { loadingDirectories.delete(relative); }
}
async function refreshFiles(): Promise<void> {
  if (!state.current || panel !== 'files') return;
  await Promise.all([...expanded].map(loadDirectory));
  if (currentFile) await openFile(currentFile.path);
}
async function openFile(relative: string): Promise<void> {
  const id = state.current?.meta.id, ticket = ++fileTicket;
  if (!id) return;
  filePreview.replaceChildren(h('p', { class: 'file-note', role: 'status' }, 'Lendo arquivo…'));
  try {
    const result = await api.workspaceFile(id, relative);
    if (ticket !== fileTicket || state.current?.meta.id !== id) return;
    currentFile = result; renderFilePreview(); renderTree();
  } catch (err) { if (ticket === fileTicket) { currentFile = undefined; filePreview.replaceChildren(h('p', { class: 'file-note', role: 'alert' }, (err as Error).message)); } }
}
function renderTree(): void {
  const query = filter.value.trim().toLowerCase();
  const nodes: HTMLElement[] = [];
  const walk = (relative: string, depth: number) => {
    const dir = directories.get(relative);
    for (const entry of dir?.entries ?? []) {
      const isDirectory = entry.kind === 'directory', open = expanded.has(entry.path);
      if (!query || entry.name.toLowerCase().includes(query) || isDirectory) {
        const button = h('button', { class: `file-entry${currentFile?.path === entry.path ? ' selected' : ''}`, type: 'button', title: entry.path,
          'data-fk': `file-${entry.path}`, ...(isDirectory ? { 'aria-expanded': String(open) } : {}), disabled: entry.kind === 'link',
          onClick: () => { if (isDirectory) { if (open) expanded.delete(entry.path); else { expanded.add(entry.path); if (!directories.has(entry.path)) void loadDirectory(entry.path); } renderTree(); }
            else void openFile(entry.path); } }, h('span', { class: 'file-symbol', 'aria-hidden': 'true' }, isDirectory ? open ? '▾' : '▸' : '·'), entry.name);
        button.style.setProperty('--depth', String(depth)); nodes.push(button);
      }
      if (isDirectory && open && depth < 20) walk(entry.path, depth + 1);
    }
    if (dir?.truncated) nodes.push(h('p', { class: 'file-note' }, 'Mostrando as primeiras 500 entradas desta pasta.'));
  };
  walk('', 0);
  keepFocus(fileTree, () => fileTree.replaceChildren(...nodes));
}
function renderFiles(): void {
  rootLabel.textContent = state.current?.meta.cwd ?? 'Nenhuma pasta selecionada'; rootLabel.title = rootLabel.textContent;
  if (!state.current) { fileTree.replaceChildren(h('p', { class: 'file-note' }, 'Crie ou abra uma conversa para ver a pasta do projeto.')); }
  else if (directoryError) fileTree.replaceChildren(h('p', { class: 'file-note', role: 'alert' }, directoryError));
  else if (!directories.has('')) { fileTree.replaceChildren(h('p', { class: 'file-note' }, 'Carregando arquivos…')); void loadDirectory(''); }
  else renderTree();
  renderFilePreview();
}
function renderFilePreview(): void {
  if (!currentFile) { filePreview.replaceChildren(h('div', { class: 'harness-empty' }, icon('folder'), h('h3', {}, 'Abra um arquivo.'), h('p', {}, 'Visualize o código com números de linha ou insira um trecho no chat.'))); return; }
  const file = currentFile;
  const lines = file.text.split('\n');
  const content = h('pre', { class: 'source-view', tabindex: '0', 'aria-label': `Conteúdo de ${file.path}` }, ...lines.slice(0, 2500).map((line, index) => h('span', { class: 'source-line', 'data-line': String(index + 1) }, line || ' ')));
  filePreview.replaceChildren(h('div', { class: 'file-preview-head' }, h('b', { title: file.path }, file.path), h('span', { class: 'muted small' }, `${file.bytes.toLocaleString('pt-BR')} bytes · leitura`)),
    file.binary ? h('p', { class: 'file-note' }, 'Este arquivo é binário. A prévia mostra somente arquivos de texto.') : h('div', { class: 'file-preview-actions' },
      h('button', { class: 'btn', type: 'button', onClick: () => void navigator.clipboard.writeText(file.text).then(() => toast('Trecho copiado.'), fail) }, 'Copiar'),
      h('button', { class: 'btn tonal', type: 'button', onClick: () => {
        const prompt = document.getElementById('prompt') as HTMLTextAreaElement;
        ctx.setPrompt(`${prompt.value}${prompt.value ? '\n\n' : ''}Arquivo: ${file.path}\n\n${file.text.slice(0, 12000)}`);
        ctx.focusComposer();
      } }, 'Inserir trecho no chat')),
    file.truncated || lines.length > 2500 ? h('p', { class: 'file-note' }, 'Prévia limitada a 256 KB e 2.500 linhas.') : '',
    file.binary ? '' : content);
}

// ---------- native, isolated browser ----------
let browsing: BrowserState = { supported: false, url: '', title: '', loading: false, canBack: false, canForward: false };
let requestedUrl = '';
const address = h('input', { class: 'browser-address', placeholder: 'URL ou localhost:3000', 'aria-label': 'Endereço do navegador',
  onKeydown: (event: KeyboardEvent) => { if (event.key === 'Enter') { event.preventDefault(); openBrowser(address.value); } } });
const go = h('button', { class: 'btn tonal', type: 'button', onClick: () => openBrowser(address.value) }, 'Ir');
const back = h('button', { class: 'btn', type: 'button', 'aria-label': 'Página anterior', onClick: () => void api.browserCommand('back').catch(fail) }, '←');
const forward = h('button', { class: 'btn', type: 'button', 'aria-label': 'Próxima página', onClick: () => void api.browserCommand('forward').catch(fail) }, '→');
const reload = h('button', { class: 'btn', type: 'button', onClick: () => void api.browserCommand(browsing.loading ? 'stop' : 'reload').catch(fail) }, 'Recarregar');
const browserNotice = h('p', { class: 'browser-notice', role: 'status' });
const browserViewport = h('div', { class: 'browser-viewport', 'aria-label': 'Página da web' });
const browserHome = h('div', { class: 'browser-home' });
browserViewport.append(browserHome);
browserPage.append(h('div', { class: 'browser-controls' }, back, forward, reload), h('div', { class: 'browser-url-row' }, address, go), browserNotice, browserViewport);
export function openBrowser(input: string): void {
  try {
    const url = browserUrl(input); requestedUrl = url; address.value = url;
    setPanel('browser');
    if (browsing.supported) { scheduleBounds(); void api.browserNavigate(url).catch(fail); }
    else void api.browserState().then((state) => { onBrowserState(state); if (state.supported) { scheduleBounds(); void api.browserNavigate(url).catch(fail); } });
    renderBrowser();
  } catch (err) { fail(err); }
}
export function openProjectPreview(url: string): void {
  wide = false;
  harnessEl.closest('.workbench')?.classList.remove('panel-wide');
  openBrowser(url);
}
function onBrowserState(value: BrowserState): void { browsing = value; renderBrowser(); scheduleBounds(); }
function renderBrowser(): void {
  if (document.activeElement !== address) address.value = browsing.url || requestedUrl;
  back.disabled = !browsing.canBack; forward.disabled = !browsing.canForward; reload.disabled = !browsing.supported || !browsing.url;
  reload.textContent = browsing.loading ? 'Parar' : 'Recarregar';
  browserNotice.textContent = browsing.error ?? (browsing.loading ? 'Carregando página…' : browsing.title || 'Pré-visualize sites e servidores locais ao lado do chat.');
  browserHome.hidden = browsing.supported && !!(browsing.url || requestedUrl);
  browserHome.replaceChildren(icon('eye'), h('h3', {}, browsing.supported ? 'Uma janela para explorar.' : 'O navegador vive no app desktop.'),
    h('p', {}, browsing.supported ? 'Digite um endereço acima. Os links das respostas também abrem neste painel.' : 'A prévia web não incorpora páginas externas. No Electron, elas abrem aqui, em uma sessão separada.'),
    !browsing.supported && requestedUrl ? h('a', { class: 'btn tonal', href: requestedUrl, target: '_blank', rel: 'noopener noreferrer' }, 'Abrir página em outra aba') : '');
}
let boundsFrame = 0, lastBounds = '';
function scheduleBounds(): void {
  if (boundsFrame) return;
  boundsFrame = requestAnimationFrame(() => {
    boundsFrame = 0;
    const rect = browserViewport.getBoundingClientRect();
    const visible = panel === 'browser' && browsing.supported && !!(browsing.url || requestedUrl) && !document.querySelector('.backdrop') && !document.hidden;
    const bounds = { visible, x: Math.max(0, rect.x), y: Math.max(0, rect.y), width: Math.max(0, rect.width), height: Math.max(0, rect.height) };
    const next = JSON.stringify(bounds);
    if (next !== lastBounds) { lastBounds = next; void api.browserBounds(bounds).catch(() => {}); }
  });
}
export function renderHarness(): void {
  const id = state.current?.meta.id;
  if (conversationId !== id) {
    conversationId = id; records = liveRecord && liveRecord.conversationId === id ? [liveRecord] : []; chosenRun = ''; signature = ''; directories.clear(); loadingDirectories.clear(); expanded.clear(); expanded.add(''); currentFile = undefined; fileTicket++; directoryError = '';
    if (panel === 'activity') void refreshHistory();
  }
  if (panel === 'activity') renderActivity();
  else if (panel === 'files') renderFiles();
}
export function initHarness(): void {
  setInterval(() => {
    const run = records.find((record) => record.id === chosenRun);
    const el = activity.querySelector<HTMLElement>('[data-elapsed]');
    if (panel === 'activity' && run?.status === 'running' && el?.dataset.elapsed === run.id) el.textContent = `${Math.max(0, Math.round((Date.now() - Date.parse(run.startedAt)) / 1000))}s até agora`;
  }, 1000);
  new ResizeObserver(scheduleBounds).observe(browserViewport);
  new MutationObserver(scheduleBounds).observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['class', 'hidden'] });
  window.addEventListener('resize', scheduleBounds);
  document.addEventListener('visibilitychange', scheduleBounds);
  void api.browserState().then(onBrowserState).catch(() => {});
}
