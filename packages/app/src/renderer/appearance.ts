import { h } from './dom.js';
import { segmented } from './seg.js';
import { appearance, setAppearance, TEXT_SIZE_LABEL, type ThemeChoice } from './theme.js';
import { openDialog } from './ui.js';

export function openAppearance(): void {
  openDialog({
    label: 'Aparência',
    narrow: true,
    build: (close) => {
      const theme = segmented<ThemeChoice>({
        labelledBy: 'ap-theme',
        value: appearance.theme,
        items: [
          { value: 'auto', label: 'Automático', icon: 'contrast' },
          { value: 'light', label: 'Claro', icon: 'sun' },
          { value: 'dark', label: 'Escuro', icon: 'moon' },
        ],
        onChange: (v) => {
          setAppearance({ theme: v });
          theme.set(v);
        },
      });
      const size = segmented<string>({
        labelledBy: 'ap-size',
        value: String(appearance.textSize),
        items: TEXT_SIZE_LABEL.map((label, i) => ({ value: String(i), label })),
        onChange: (v) => {
          setAppearance({ textSize: Number(v) });
          size.set(v);
        },
      });
      const motion = h('button', {
        type: 'button',
        class: 'switch',
        role: 'switch',
        'aria-checked': String(appearance.reduceMotion),
        'aria-labelledby': 'ap-motion',
        onClick: () => {
          setAppearance({ reduceMotion: !appearance.reduceMotion });
          motion.setAttribute('aria-checked', String(appearance.reduceMotion));
        },
      });
      const office = h('button', {
        type: 'button', class: 'switch', role: 'switch',
        'aria-checked': String(appearance.office3d), 'aria-labelledby': 'ap-office',
        onClick: () => {
          setAppearance({ office3d: !appearance.office3d });
          office.setAttribute('aria-checked', String(appearance.office3d));
        },
      });
      return h(
        'div',
        { class: 'dialog-pad' },
        h('h2', {}, 'Aparência'),
        h('div', { class: 'opt-row' }, h('b', { id: 'ap-theme' }, 'Tema'), theme.el),
        h('div', { class: 'opt-row' }, h('b', { id: 'ap-size' }, 'Tamanho do texto'), size.el),
        h('div', { class: 'opt-row' }, h('b', { id: 'ap-motion' }, 'Reduzir animações'), motion),
        h('div', { class: 'opt-row' }, h('b', { id: 'ap-office' }, 'Escritório 3D'), office),
        h('p', { class: 'muted small' }, 'Um espaço com personagens para acompanhar sua equipe, junto do chat. Opcional e salvo neste computador.'),
        h('p', { class: 'muted small' }, 'O app também respeita a opção de reduzir movimento do Windows.'),
        h('div', { class: 'row-end' }, h('button', { class: 'btn primary', type: 'button', onClick: close }, 'Pronto')),
      );
    },
  });
}
