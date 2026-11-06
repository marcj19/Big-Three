import { parseMarkdown, safeLink, type Block, type Inline } from './markdown.js';
import { ctx } from './ctx.js';

type Child = Node | string | null | undefined | false;
type Props = Record<string, unknown>;

/**
 * Builds elements without ever parsing HTML: text goes in as text, so whatever a model writes cannot become
 * markup or script in the window.
 */
export function h<K extends keyof HTMLElementTagNameMap>(tag: K, props: Props = {}, ...children: Child[]): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (value === undefined || value === null || value === false) continue;
    if (key === 'class') el.className = String(value);
    else if (key.startsWith('on') && typeof value === 'function') el.addEventListener(key.slice(2).toLowerCase(), value as EventListener);
    else if (key === 'value' || key === 'checked' || key === 'disabled' || key === 'selected') (el as unknown as Record<string, unknown>)[key] = value;
    else el.setAttribute(key, value === true ? '' : String(value));
  }
  for (const child of children) if (child !== null && child !== undefined && child !== false) el.append(child);
  return el;
}

export const clear = (el: Element): void => el.replaceChildren();

/** Re-renders a region without dropping keyboard focus: the focused control is found again by its `data-fk`. */
export function keepFocus(region: Element, render: () => void): void {
  const active = document.activeElement;
  const key = active instanceof HTMLElement && region.contains(active) ? active.dataset.fk : undefined;
  render();
  if (key) region.querySelector<HTMLElement>(`[data-fk="${CSS.escape(key)}"]`)?.focus({ preventScroll: true });
}

/**
 * Keeps `container` in step with `items` by key: nodes that already exist are reused untouched (so they do not
 * replay their entrance animation or lose scroll/selection), new ones are created, stale ones removed.
 */
export function syncChildren(container: Element, items: { key: string; create: () => HTMLElement; update?: (el: HTMLElement) => void }[]): void {
  const existing = new Map<string, HTMLElement>();
  for (const child of Array.from(container.children)) if (child instanceof HTMLElement && child.dataset.key) {
    if (existing.has(child.dataset.key)) child.remove();
    else existing.set(child.dataset.key, child);
  }
  let previous: Element | null = null;
  const placed = new Set<string>();
  for (const item of items) {
    if (placed.has(item.key)) continue;
    placed.add(item.key);
    let el = existing.get(item.key);
    if (el) {
      existing.delete(item.key);
      item.update?.(el);
    } else {
      el = item.create();
      el.dataset.key = item.key;
    }
    const wanted: Element | null = previous ? previous.nextElementSibling : container.firstElementChild;
    if (wanted !== el) container.insertBefore(el, wanted);
    previous = el;
  }
  for (const stale of existing.values()) stale.remove();
}

const inline = (parts: Inline[]): (Node | string)[] => parts.map((p) => {
  if (p.kind === 'text') return p.value;
  if (p.kind === 'break') return h('br');
  if (p.kind === 'link') {
    const href = safeLink(p.href ?? '');
    return href ? h('a', { href, title: href, rel: 'noopener noreferrer', onClick: (event: MouseEvent) => {
      event.preventDefault(); ctx.openBrowser(href);
    } }, ...(p.children ? inline(p.children) : [p.value])) : p.value;
  }
  return h(p.kind === 'bold' ? 'strong' : p.kind === 'italic' ? 'em' : p.kind === 'strike' ? 'del' : 'code',
    p.kind === 'code' ? { class: 'ic-code' } : {}, ...(p.children ? inline(p.children) : [p.value]));
});

/** A model's reply as elements: Markdown subset, with a copy button on code blocks. Every string goes in as text. */
export function renderRichText(text: string, onCopy: (code: string) => void): HTMLElement {
  const root = h('div', { class: 'body' });
  const appendBlocks = (container: HTMLElement, blocks: Block[]) => { for (const block of blocks) {
    if (block.kind === 'code') {
      container.append(
        h(
          'div',
          { class: 'code' },
          h('div', { class: 'code-head' }, h('span', { class: 'code-language' }, block.language ?? 'texto'), h('button', { class: 'btn text', type: 'button', onClick: () => onCopy(block.value) }, 'Copiar código')),
          h('pre', { tabindex: '0' }, h('code', {}, block.value)),
        ),
      );
    } else if (block.kind === 'heading') {
      container.append(h(`h${block.level + 2}` as 'h3' | 'h4' | 'h5', { class: 'md-h' }, ...inline(block.inline)));
    } else if (block.kind === 'list') {
      container.append(h(block.ordered ? 'ol' : 'ul', { ...(block.ordered ? { start: block.start } : {}) }, ...block.items.map((item) => {
        const li = h('li', item.checked === undefined ? {} : { class: 'task-item' });
        if (item.checked !== undefined) li.append(h('input', { type: 'checkbox', checked: item.checked, disabled: true, 'aria-label': item.checked ? 'Concluído' : 'Pendente' }));
        appendBlocks(li, item.blocks); return li;
      })));
    } else if (block.kind === 'quote') {
      const quote = h('blockquote'); appendBlocks(quote, block.blocks); container.append(quote);
    } else if (block.kind === 'table') {
      const cell = (tag: 'th' | 'td', parts: Inline[], index: number) => h(tag, { ...(tag === 'th' ? { scope: 'col' } : {}), class: `align-${block.align[index] ?? 'left'}` }, ...inline(parts));
      container.append(h('div', { class: 'md-table-scroll', tabindex: '0', role: 'region', 'aria-label': 'Tabela da resposta' },
        h('table', {}, h('thead', {}, h('tr', {}, ...block.header.map((parts, i) => cell('th', parts, i)))),
          h('tbody', {}, ...block.rows.map((row) => h('tr', {}, ...row.map((parts, i) => cell('td', parts, i))))))));
    } else if (block.kind === 'rule') {
      container.append(h('hr'));
    } else {
      container.append(h('p', {}, ...inline(block.inline)));
    }
  } };
  appendBlocks(root, parseMarkdown(text));
  return root;
}

export function formatTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toDateString() === new Date().toDateString()
    ? d.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })
    : d.toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' });
}

/** "agora", "há 5 min", "ontem": easier to scan than a clock time. */
export function relativeTime(iso: string): string {
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return '';
  const min = Math.round((Date.now() - t) / 60_000);
  if (min < 1) return 'agora';
  if (min < 60) return `há ${min} min`;
  const hours = Math.round(min / 60);
  if (hours < 24 && new Date(iso).toDateString() === new Date().toDateString()) return `há ${hours} h`;
  return formatTime(iso);
}

export function dayGroup(iso: string): string {
  const d = new Date(iso);
  const days = Math.floor((new Date().setHours(0, 0, 0, 0) - new Date(d).setHours(0, 0, 0, 0)) / 86_400_000);
  return days <= 0 ? 'Hoje' : days === 1 ? 'Ontem' : days < 7 ? 'Últimos 7 dias' : 'Mais antigas';
}
