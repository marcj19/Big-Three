import type { GitChange, GitDiff, GitSelection, GitStatus } from '../shared/api.js';
import { api } from './bridge.js';
import { h, keepFocus } from './dom.js';
import { icon } from './icons.js';

let conversation: string | undefined;
let statusTicket = 0;
let diffTicket = 0;
let loadingStatus = false;
let selected: GitSelection | undefined;

const summary = h('div', { class: 'git-summary', role: 'status' });
const refresh = h('button', { class: 'btn', type: 'button', onClick: () => void refreshGit(conversation) }, icon('refresh', 'sm'), 'Atualizar');
const changes = h('div', { class: 'git-changes' });
const preview = h('div', { class: 'git-preview' });
export const gitPage = h('section', { class: 'harness-page git-page', 'aria-label': 'Controle de versão do projeto', hidden: true },
  h('div', { class: 'git-header' }, summary, refresh), changes, preview);

const STATUS_LABELS: Record<string, string> = {
  M: 'Modificado', A: 'Adicionado', D: 'Excluído', R: 'Renomeado', C: 'Copiado', T: 'Tipo alterado', U: 'Conflito', '?': 'Novo arquivo',
};
const GROUPS = [
  ['worktree', 'Alterações locais'], ['index', 'Preparado para commit'],
] as const;

function selections(change: GitChange): { selection: GitSelection; status: string }[] {
  const { path, previousPath, index, worktree } = change;
  if (index === '?') return [{ selection: { path, source: 'untracked' }, status: '?' }];
  if (index === 'U' || worktree === 'U' || index + worktree === 'AA' || index + worktree === 'DD') {
    return [{ selection: { path, source: 'worktree' }, status: 'U' }];
  }
  return GROUPS.flatMap(([source]) => {
    const code = change[source];
    return code === ' ' ? [] : [{ selection: { path, previousPath: /[RC]/.test(code) ? previousPath : undefined, source }, status: code }];
  });
}

function renderChanges(status: Extract<GitStatus, { kind: 'repository' }>): void {
  const entries = status.changes.flatMap(selections);
  selected = entries.find(({ selection }) => selection.path === selected?.path && selection.source === selected.source)?.selection;
  const groups = GROUPS.map(([source, label]) => {
    const list = entries.filter(({ selection }) => selection.source === source || (source === 'worktree' && selection.source === 'untracked'));
    return list.length ? h('section', { class: 'git-group' }, h('h3', {}, `${label} · ${list.length}`),
      h('ul', {}, ...list.map(({ selection, status: code }) => {
        const name = selection.previousPath ? `${selection.previousPath} → ${selection.path}` : selection.path;
        const detail = STATUS_LABELS[code] ?? code;
        return h('li', {}, h('button', {
          type: 'button', title: `${detail} · ${name}`, 'data-fk': `${selection.source}:${selection.path}`,
          'aria-label': `${detail}, ${name}`, 'aria-pressed': String(selection === selected),
          onClick: () => void openDiff(selection),
        }, h('span', { class: 'git-file-status', 'aria-hidden': 'true' }, code), h('span', {}, name)));
      }))) : '';
  });
  keepFocus(changes, () => changes.replaceChildren(...groups,
    ...(status.truncated ? [h('p', { class: 'file-note' }, 'Mostrando apenas parte das alterações.')] : [])));
}

function notice(message: string, role = 'status'): HTMLElement {
  return h('p', { class: 'file-note', role }, message);
}

function renderDiff(selection: GitSelection, diff: GitDiff): void {
  const label = selection.source === 'untracked' ? 'Prévia de arquivo novo' : selection.source === 'index' ? 'Diferenças no próximo commit' : 'Diferenças locais';
  const lines = diff.text.split('\n');
  const content = selection.source === 'untracked' ? [diff.text] : lines.slice(0, 1200).map((line, index) => {
    const mark = line.startsWith('+++ ') || line.startsWith('--- ') ? '' : line[0];
    const className = mark === '+' ? 'git-line-added' : mark === '-' ? 'git-line-removed' : mark === '@' ? 'git-line-range' : undefined;
    return h('span', { class: className }, line, index < lines.length - 1 ? '\n' : '');
  });
  keepFocus(preview, () => preview.replaceChildren(
    h('div', { class: 'git-preview-title' }, h('b', {}, selection.path), h('span', {}, label)),
    diff.binary ? notice('Arquivo binário.') : diff.text ? h('pre', { tabindex: '0', 'aria-label': label, 'data-fk': 'diff' }, ...content)
      : notice(selection.source === 'untracked' ? 'Arquivo vazio.' : 'A diferença não está mais disponível. Atualize a lista.'),
    ...(diff.truncated || (selection.source !== 'untracked' && lines.length > 1200) ? [notice('Prévia limitada para arquivos grandes.')] : []),
  ));
}

async function openDiff(selection: GitSelection): Promise<void> {
  const id = conversation;
  if (!id) return;
  const sameFile = selected?.path === selection.path && selected.source === selection.source;
  selected = selection;
  const ticket = ++diffTicket;
  const key = `${selection.source}:${selection.path}`;
  for (const button of changes.querySelectorAll('button')) button.setAttribute('aria-pressed', String(button.dataset.fk === key));
  preview.setAttribute('aria-busy', 'true');
  if (!sameFile || !preview.querySelector('pre')) preview.replaceChildren(notice('Carregando diferença…'));
  try {
    const result = await api.gitDiff(id, selection);
    if (ticket === diffTicket) renderDiff(selection, result);
  } catch (err) {
    if (ticket === diffTicket) preview.replaceChildren(notice(err instanceof Error ? err.message : 'Não foi possível abrir a diferença.', 'alert'));
  } finally {
    if (ticket === diffTicket) preview.removeAttribute('aria-busy');
  }
}

export async function refreshGit(id: string | undefined): Promise<void> {
  if (conversation !== id) {
    conversation = id;
    selected = undefined;
    summary.replaceChildren();
    changes.replaceChildren();
    preview.replaceChildren();
    preview.removeAttribute('aria-busy');
    diffTicket++;
  } else if (loadingStatus && id) return;
  const ticket = ++statusTicket;
  refresh.disabled = !id;
  loadingStatus = !!id;
  if (!id) {
    refresh.removeAttribute('aria-disabled');
    summary.removeAttribute('aria-busy');
    summary.textContent = 'Abra uma conversa com uma pasta de projeto.';
    return;
  }
  refresh.setAttribute('aria-disabled', 'true');
  summary.setAttribute('aria-busy', 'true');
  if (!summary.querySelector('b')) summary.textContent = 'Consultando o Git…';
  try {
    const status = await api.gitStatus(id);
    if (ticket !== statusTicket) return;
    if (status.kind !== 'repository') {
      selected = undefined;
      diffTicket++;
      changes.replaceChildren();
      preview.replaceChildren();
      preview.removeAttribute('aria-busy');
      summary.textContent = status.kind === 'unavailable'
        ? 'Git não encontrado. Instale o Git e reabra o Big Three.' : 'A pasta desta conversa não está em um repositório Git.';
      return;
    }
    summary.replaceChildren(
      h('b', {}, icon('branch', 'sm'), status.branch || 'HEAD destacado'),
      h('span', {}, status.origin ? `origin · ${status.origin}` : 'Sem remoto origin'),
      ...(status.upstream ? [h('span', {}, `${status.upstream} · ${status.ahead} à frente · ${status.behind} atrás`,
        h('small', {}, 'Comparação com a referência local'))] : []),
    );
    renderChanges(status);
    if (selected) void openDiff(selected);
    else {
      diffTicket++;
      preview.removeAttribute('aria-busy');
      preview.replaceChildren(notice(status.changes.length ? 'Selecione um arquivo para revisar suas alterações.' : 'Nenhuma alteração nesta pasta.'));
    }
  } catch (err) {
    if (ticket !== statusTicket) return;
    summary.textContent = err instanceof Error ? err.message : 'Não foi possível consultar o Git.';
  } finally {
    if (ticket === statusTicket) {
      summary.removeAttribute('aria-busy');
      refresh.removeAttribute('aria-disabled');
      loadingStatus = false;
    }
  }
}
