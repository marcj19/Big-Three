import { h } from './dom.js';
import { icon } from './icons.js';

const reduced = () => matchMedia('(prefers-reduced-motion: reduce)').matches || document.documentElement.dataset.motion === 'reduce';

// ---------- toasts ----------

let toastHost: HTMLElement | undefined;
const host = (): HTMLElement => (toastHost ??= document.body.appendChild(h('div', { class: 'toasts' })));

/** Short messages at the bottom, announced to screen readers. Errors stay until dismissed. */
export function toast(text: string, kind: 'info' | 'success' | 'error' = 'info'): void {
  const el = h(
    'div',
    { class: `toast ${kind}`, role: kind === 'error' ? 'alert' : 'status' },
    icon(kind === 'error' ? 'alert' : kind === 'success' ? 'check' : 'info'),
    h('div', { class: 'msg-t' }, text),
    h('button', { class: 'icon-btn', type: 'button', 'aria-label': 'Dispensar aviso', onClick: () => dismiss() }, icon('x', 'sm')),
  );
  let timer: ReturnType<typeof setTimeout> | undefined;
  const dismiss = () => {
    clearTimeout(timer);
    el.classList.add('leaving');
    setTimeout(() => el.remove(), reduced() ? 0 : 200);
  };
  host().append(el);
  while (host().children.length > 3) host().firstElementChild?.remove();
  if (kind !== 'error') timer = setTimeout(dismiss, kind === 'success' ? 3500 : 5000);
}

// ---------- dialogs ----------

const FOCUSABLE = 'a[href], button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])';

export interface DialogHandle {
  close(): void;
  /** The dialog element, to re-render its content. */
  el: HTMLElement;
}

/**
 * A modal dialog that behaves like one for keyboard and screen-reader users: focus moves in, Tab stays inside,
 * Esc and a click outside close it, and focus returns to what opened it.
 */
export function openDialog(options: { label: string; narrow?: boolean; build: (close: () => void) => HTMLElement; onClose?: () => void }): DialogHandle {
  const opener = document.activeElement instanceof HTMLElement ? document.activeElement : undefined;
  const dialog = h('div', { class: `dialog${options.narrow ? ' narrow' : ''}`, role: 'dialog', 'aria-modal': 'true', 'aria-label': options.label, tabindex: '-1' });
  const backdrop = h('div', { class: 'backdrop' }, dialog);
  let closed = false;

  const close = () => {
    if (closed) return;
    closed = true;
    document.removeEventListener('keydown', onKey, true);
    backdrop.classList.add('closing');
    setTimeout(() => {
      backdrop.remove();
      opener?.focus({ preventScroll: true });
      options.onClose?.();
    }, reduced() ? 0 : 160);
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.stopPropagation();
      close();
    } else if (e.key === 'Tab') {
      const items = Array.from(dialog.querySelectorAll<HTMLElement>(FOCUSABLE)).filter((n) => n.offsetParent !== null);
      if (!items.length) return e.preventDefault();
      const first = items[0]!;
      const last = items[items.length - 1]!;
      if (e.shiftKey && (document.activeElement === first || document.activeElement === dialog)) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    }
  };
  backdrop.addEventListener('mousedown', (e) => {
    if (e.target === backdrop) close();
  });
  document.addEventListener('keydown', onKey, true);
  dialog.append(options.build(close));
  document.body.append(backdrop);
  (dialog.querySelector<HTMLElement>('[autofocus], input:not(:disabled), button:not(:disabled)') ?? dialog).focus({ preventScroll: true });
  return { close, el: dialog };
}

export function confirmDialog(options: { title: string; message: string; confirm: string; danger?: boolean }): Promise<boolean> {
  return new Promise((resolve) => {
    let answer = false;
    openDialog({
      label: options.title,
      narrow: true,
      onClose: () => resolve(answer),
      build: (close) =>
        h(
          'div',
          { class: 'dialog-pad' },
          h('h2', {}, options.title),
          h('p', { class: 'muted' }, options.message),
          h(
            'div',
            { class: 'row-end' },
            h('button', { class: 'btn', type: 'button', onClick: close }, 'Cancelar'),
            h(
              'button',
              {
                class: `btn ${options.danger ? 'danger' : 'primary'}`,
                type: 'button',
                autofocus: true,
                onClick: () => {
                  answer = true;
                  close();
                },
              },
              options.confirm,
            ),
          ),
        ),
    });
  });
}
