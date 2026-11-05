import type { UpdateCommand, UpdateState } from '../shared/api.js';
import { api } from './bridge.js';
import { ctx } from './ctx.js';
import { h, keepFocus } from './dom.js';
import { icon } from './icons.js';
import { openDialog, toast } from './ui.js';

let update: UpdateState = { phase: 'unavailable' };
let dialogBody: HTMLElement | undefined;

export function onUpdate(next: UpdateState): void {
  const changed = next.phase !== update.phase || next.availableVersion !== update.availableVersion;
  update = next;
  if (changed) ctx.renderSidebar();
  if (dialogBody) render(dialogBody);
}

export function updatesButton(): HTMLElement {
  const ready = update.phase === 'available' || update.phase === 'ready';
  return h('button', { class: ready ? 'btn tonal block' : 'btn text block', type: 'button', 'data-fk': 'app-updates', onClick: openUpdates },
    icon('refresh', 'sm'), ready ? 'Atualização disponível' : 'Atualizações');
}

async function perform(command: UpdateCommand): Promise<void> {
  try { onUpdate(await api.update(command)); }
  catch (error) { toast((error as Error).message, 'error'); }
}

function render(body: HTMLElement): void {
  const status = {
    unavailable: 'Use a versão instalada do Big Three para atualizar por aqui.',
    idle: 'Consulte as versões publicadas no GitHub.',
    checking: 'Verificando novas versões…',
    current: 'Você já está na versão mais recente.',
    available: 'A versão ' + update.availableVersion + ' está disponível.',
    downloading: 'Baixando a versão ' + update.availableVersion + '…',
    ready: 'A versão ' + update.availableVersion + ' está pronta para instalar.',
    installing: 'O Big Three vai reiniciar para concluir a instalação.',
    error: update.message ?? 'A atualização falhou. Tente novamente.',
  }[update.phase];
  const command = update.phase === 'ready' ? 'install' : update.phase === 'available' ? 'download' : 'check';
  const busy = ['checking', 'downloading', 'installing'].includes(update.phase);
  keepFocus(body, () => body.replaceChildren(
    h('p', { class: 'muted', role: 'status' }, status),
    update.phase === 'downloading' ? h('progress', { max: 100, value: update.percent ?? 0, 'aria-label': 'Progresso da atualização' }) : '',
    h('div', { class: 'row-end' }, update.phase !== 'unavailable' ? h('button', {
      class: 'btn primary', type: 'button', 'data-fk': 'update-action', disabled: busy, onClick: () => void perform(command),
    }, command === 'install' ? 'Instalar e reiniciar' : command === 'download' ? 'Baixar atualização' : 'Verificar atualização') : ''),
  ));
}

function openUpdates(): void {
  const body = h('div');
  dialogBody = body;
  openDialog({
    label: 'Atualizações',
    narrow: true,
    onClose: () => { if (dialogBody === body) dialogBody = undefined; },
    build: (close) => h('div', { class: 'dialog-pad' },
      h('h2', {}, 'Atualizações'),
      update.version ? h('p', { class: 'muted small' }, 'Big Three ' + update.version) : '',
      body,
      h('div', { class: 'row-end' }, h('button', { class: 'btn text', type: 'button', onClick: () => {
        close();
        ctx.openBrowser('https://github.com/marcj19/Big-Three/releases');
      } }, 'Ver versões no GitHub'), h('button', { class: 'btn', type: 'button', onClick: close }, 'Fechar')),
    ),
  });
  render(body);
}
