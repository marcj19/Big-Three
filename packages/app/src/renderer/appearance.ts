import { h } from './dom.js';
import { segmented } from './seg.js';
import { ACCENTS, appearance, setAppearance, TEXT_SIZE_LABEL, type AccentChoice, type SidebarDensity, type SidebarWidth, type ThemeChoice } from './theme.js';
import { openDialog } from './ui.js';

function toggleOption(key: 'showSidebarUsage' | 'reduceMotion' | 'office3d', label: string): HTMLElement {
  const id = `ap-${key}`;
  const control = h('button', {
    type: 'button', class: 'switch', role: 'switch', 'aria-checked': String(appearance[key]), 'aria-labelledby': id,
    onClick: () => {
      setAppearance({ [key]: !appearance[key] });
      control.setAttribute('aria-checked', String(appearance[key]));
    },
  });
  return h('div', { class: 'opt-row' }, h('b', { id }, label), control);
}

export function openAppearance(): void {
  openDialog({
    label: 'Configurações de aparência',
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
      const accent = h('select', { class: 'sel', id: 'ap-accent', onChange: () => setAppearance({ accent: accent.value as AccentChoice }) },
        ...Object.entries(ACCENTS).map(([value, label]) => h('option', { value, selected: value === appearance.accent }, label)));
      const density = segmented<SidebarDensity>({
        labelledBy: 'ap-density', value: appearance.sidebarDensity,
        items: [{ value: 'comfortable', label: 'Confortável' }, { value: 'compact', label: 'Compacta' }],
        onChange: (v) => { setAppearance({ sidebarDensity: v }); density.set(v); },
      });
      const width = segmented<SidebarWidth>({
        labelledBy: 'ap-width', value: appearance.sidebarWidth,
        items: [{ value: 'narrow', label: 'Estreita' }, { value: 'medium', label: 'Média' }, { value: 'wide', label: 'Larga' }],
        onChange: (v) => { setAppearance({ sidebarWidth: v }); width.set(v); },
      });
      return h(
        'div',
        { class: 'dialog-pad appearance-settings' },
        h('h2', {}, 'Configurações'),
        h('section', { 'aria-labelledby': 'ap-interface' },
          h('h3', { id: 'ap-interface' }, 'Interface'),
          h('div', { class: 'opt-row' }, h('b', { id: 'ap-theme' }, 'Tema'), theme.el),
          h('div', { class: 'opt-row' }, h('label', { for: 'ap-accent' }, 'Cor de destaque'), accent),
          h('div', { class: 'opt-row' }, h('b', { id: 'ap-size' }, 'Tamanho do texto'), size.el)),
        h('section', { 'aria-labelledby': 'ap-sidebar' },
          h('h3', { id: 'ap-sidebar' }, 'Barra lateral'),
          h('div', { class: 'opt-row' }, h('b', { id: 'ap-density' }, 'Densidade'), density.el),
          h('div', { class: 'opt-row' }, h('b', { id: 'ap-width' }, 'Largura'), width.el),
          toggleOption('showSidebarUsage', 'Exibir indicadores de uso')),
        h('section', { 'aria-labelledby': 'ap-motion' },
          h('h3', { id: 'ap-motion' }, 'Movimento'),
          toggleOption('reduceMotion', 'Reduzir animações'),
          toggleOption('office3d', 'Escritório 3D')),
        h('div', { class: 'row-end' }, h('button', { class: 'btn primary', type: 'button', onClick: close }, 'Pronto')),
      );
    },
  });
}
