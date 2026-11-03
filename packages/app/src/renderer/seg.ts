import { h } from './dom.js';
import { icon, type IconName } from './icons.js';

export interface SegItem<T extends string> {
  value: T;
  label: string;
  icon?: IconName;
  title?: string;
}

export interface Segmented<T extends string> {
  el: HTMLElement;
  /** Moves the selection (and the sliding thumb) without rebuilding anything, so it animates. */
  set(value: T): void;
}

/**
 * A segmented control with a thumb that slides to the chosen option. The element is built once and updated in
 * place: re-creating it on every change would make the thumb jump instead of glide.
 */
export function segmented<T extends string>(options: {
  items: SegItem<T>[];
  value: T;
  onChange: (value: T) => void;
  label?: string;
  labelledBy?: string;
  className?: string;
}): Segmented<T> {
  const { items } = options;
  const el = h('div', { class: `seg ${options.className ?? ''}`.trim(), role: 'radiogroup', 'aria-label': options.label, 'aria-labelledby': options.labelledBy });
  el.style.setProperty('--n', String(items.length));
  const buttons = items.map((item) =>
    h(
      'button',
      { type: 'button', role: 'radio', title: item.title, onClick: () => options.onChange(item.value) },
      item.icon ? icon(item.icon, 'sm') : '',
      item.label,
    ),
  );
  el.append(...buttons);

  const set = (value: T) => {
    const index = Math.max(0, items.findIndex((i) => i.value === value));
    el.style.setProperty('--i', String(index));
    el.dataset.value = value;
    buttons.forEach((b, i) => {
      b.setAttribute('aria-checked', String(i === index));
      b.tabIndex = i === index ? 0 : -1;
    });
  };
  set(options.value);

  // Arrow keys move through the options like native radio buttons.
  el.addEventListener('keydown', (e) => {
    const forward = e.key === 'ArrowRight' || e.key === 'ArrowDown';
    if (!forward && e.key !== 'ArrowLeft' && e.key !== 'ArrowUp') return;
    const at = buttons.indexOf(document.activeElement as HTMLButtonElement);
    if (at < 0) return;
    e.preventDefault();
    const next = (at + (forward ? 1 : -1) + buttons.length) % buttons.length;
    buttons[next]!.focus();
    options.onChange(items[next]!.value);
  });
  return { el, set };
}
