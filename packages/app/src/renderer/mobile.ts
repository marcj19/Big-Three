import type { MobileAccessState, MobileCommand } from '../shared/mobile.js';
import { downloadAndroid, mobileAccess, writeClipboardText } from './bridge.js';
import { h, keepFocus } from './dom.js';
import { openDialog, toast } from './ui.js';

export function openMobileAccess(): void {
  const content = h('div', { class: 'mobile-access' });
  let closed = false;
  let busy = false;
  let current: MobileAccessState | undefined;
  const load = async (command?: MobileCommand) => {
    if (busy || closed) return;
    busy = true;
    try {
      const next = await mobileAccess(command);
      if (closed || JSON.stringify(next) === JSON.stringify(current)) return;
      current = next;
      render(next);
    } catch (error) {
      if (!closed) toast((error as Error).message, 'error');
    } finally { busy = false; }
  };
  const render = (state: MobileAccessState) => {
    const { pairing } = state;
    keepFocus(content, () => content.replaceChildren(
      h('p', { role: 'status' }, state.paired ? 'Celular pareado.' : state.enabled ? 'Aguardando pareamento.' : 'Acesso pelo celular desativado.'),
      state.error ? h('p', { class: 'muted small' }, state.error) : '',
      pairing ? h('div', { class: 'mobile-pair' }, h('label', { for: 'mobile-code' }, 'Token de pareamento · uso único · 5 minutos'),
        h('input', { id: 'mobile-code', value: pairing.code, readonly: true, 'data-fk': 'mobile-code', spellcheck: 'false' }),
        h('button', { class: 'btn', type: 'button', 'data-fk': 'mobile-copy', onClick: () => void writeClipboardText(pairing.code)
          .then(() => toast('Token copiado.')).catch(() => toast('Selecione o token para copiar.', 'error')) }, 'Copiar token')) : '',
      pairing ? h('p', { class: 'muted small' }, 'Abra o Big Three no Android e cole este token. O aplicativo se conecta ao servidor automaticamente.') : '',
      state.paired ? h('div', { class: 'mobile-pair' }, h('p', {}, state.allowPrompts ? 'O Android pode enviar prompts em somente leitura.' : 'O Android pode acompanhar as conversas.'),
        h('button', { class: 'btn', type: 'button', 'data-fk': 'mobile-prompts', 'aria-pressed': String(state.allowPrompts),
          onClick: () => void load(state.allowPrompts ? 'block-prompts' : 'allow-prompts') }, 'Permitir envio de prompts')) : '',
      h('div', { class: 'row-end' },
        state.enabled ? h('button', { class: 'btn', type: 'button', 'data-fk': 'mobile-stop', onClick: () => void load('stop') }, 'Desativar acesso') : '',
        h('button', { class: 'btn primary', type: 'button', 'data-fk': 'mobile-pair', onClick: () => void load('pair') }, pairing || state.paired ? 'Gerar novo token' : 'Gerar token')),
    ));
  };
  const timer = setInterval(() => { if (current?.enabled) void load(); }, 2000);
  openDialog({ label: 'Acesso pelo celular', narrow: true,
    onClose: () => { closed = true; clearInterval(timer); },
    build: (close) => h('div', { class: 'dialog-pad' }, h('h2', {}, 'Acesso pelo celular'),
      h('p', { class: 'muted small' }, 'O celular pareado pode consultar o histórico recente e acompanhar a atividade das conversas deste PC enquanto o Big Three estiver aberto.'),
      h('button', { class: 'btn', type: 'button', 'data-fk': 'download-android', onClick: () => void downloadAndroid().catch(() => toast('Abra a página de releases do Big Three para baixar o APK.', 'error')) }, 'Baixar APK para Android'),
      content, h('div', { class: 'row-end' }, h('button', { class: 'btn text', type: 'button', onClick: close }, 'Fechar'))),
  });
  void load();
}
