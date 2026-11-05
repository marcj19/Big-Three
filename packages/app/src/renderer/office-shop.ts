import type { ProviderId } from '../shared/api.js';
import { h, keepFocus } from './dom.js';
import { NAMES, PROVIDERS } from './state.js';
import { appearance } from './theme.js';
import { openDialog } from './ui.js';
import { equipItem, isEquipped, ROOM_PALETTES, SHOP_ITEMS, type ShopCategory, type ShopItem, type Wardrobe } from './office-wardrobe.js';
import type { OfficeScene } from './office-scene.js';
import { shopArt } from './office-shop-art.js';

const CATEGORIES: { id: ShopCategory; label: string; mark: string }[] = [
  { id: 'outfit', label: 'Roupas', mark: '◒' }, { id: 'hat', label: 'Chapéus', mark: '◓' },
  { id: 'accessory', label: 'Acessórios', mark: '◎' }, { id: 'room', label: 'Escritório', mark: '▦' },
];

export function openOfficeShop(options: { selected: ProviderId; value: Wardrobe; onSave(value: Wardrobe): void; onClose(): void }): void {
  let value = structuredClone(options.value);
  let selected = options.selected;
  let category: ShopCategory = 'outfit';
  let item = SHOP_ITEMS.find((i) => i.id === `outfit:${value.looks[selected].outfit}`)!;
  let preview: OfficeScene | undefined;
  let generation = 0, closed = false;
  const stage = h('div', { class: 'shop-stage', 'aria-label': 'Provador 3D' });
  const stageMessage = h('p', { class: 'shop-stage-message', role: 'status' }, 'Abrindo o provador…');
  stage.append(stageMessage);
  const providerButtons = h('div', { class: 'shop-providers', 'aria-label': 'Personagem para vestir' });
  const tabs = h('div', { class: 'shop-categories', 'aria-label': 'Categorias da loja' });
  const catalog = h('div', { class: 'shop-catalog' });
  const selectedName = h('h3', {});
  const selectedDescription = h('p', { class: 'muted small' });
  const action = h('button', { type: 'button', class: 'btn primary shop-equip', onClick: () => {
    value = equipItem(value, selected, item);
    options.onSave(structuredClone(value));
    render();
  } });
  const owned = h('p', { class: 'shop-owned' });
  const pace = h('select', { 'aria-label': 'Ritmo das animações', onChange: () => {
    value.pace = pace.value === 'regular' ? 'regular' : 'calm';
    options.onSave(structuredClone(value));
    applyPreview();
  } }, h('option', { value: 'calm' }, 'Tranquilo · pausas maiores'), h('option', { value: 'regular' }, 'Normal'));
  pace.value = value.pace;
  const handle = openDialog({ label: 'Loja do escritório', onClose: () => {
    closed = true; generation++; preview?.dispose(); options.onClose();
  }, build: (close) => h('div', { class: 'shop' },
    h('header', { class: 'shop-header' },
      h('div', {}, h('p', { class: 'office-eyebrow' }, 'BIG THREE · ESTÚDIO DE ESTILO'), h('h2', {}, 'Um pouco mais de personalidade.'),
        h('p', { class: 'muted small' }, 'Experimente à vontade. Os itens desta coleção são gratuitos.')),
      h('button', { type: 'button', class: 'btn', onClick: close }, 'Fechar loja')),
    h('div', { class: 'shop-body' },
      h('aside', { class: 'shop-preview' }, providerButtons, stage,
        h('div', { class: 'shop-item-info' }, selectedName, selectedDescription, owned, action),
        h('label', { class: 'shop-pace' }, 'Ritmo das animações', pace)),
      h('section', { class: 'shop-products', 'aria-label': 'Coleção gratuita' }, tabs, catalog,
        h('p', { class: 'shop-footnote' }, 'Seu guarda-roupa fica salvo neste computador. Cada IA tem o seu.')))),
  });
  handle.el.classList.add('office-shop-dialog');

  function applyPreview(): void {
    preview?.setWardrobe(equipItem(value, selected, item));
    stage.style.setProperty('--shop-stage', ROOM_PALETTES[item.category === 'room' ? item.value as Wardrobe['room'] : value.room].background);
  }
  function render(): void {
    keepFocus(handle.el, () => {
      providerButtons.replaceChildren(...PROVIDERS.map((id) => h('button', { type: 'button', class: `shop-provider ${id}`,
        'aria-pressed': String(selected === id), 'data-fk': `shop-provider-${id}`, onClick: () => {
          selected = id;
          item = SHOP_ITEMS.find((i) => i.category === category && isEquipped(value, selected, i))!;
          render(); void loadPreview();
        } }, NAMES[id])));
      tabs.replaceChildren(...CATEGORIES.map((c) => h('button', { type: 'button', 'aria-pressed': String(category === c.id), 'data-fk': `shop-category-${c.id}`,
        onClick: () => {
          const wasRoom = category === 'room';
          category = c.id; item = SHOP_ITEMS.find((i) => i.category === category && isEquipped(value, selected, i))!;
          render(); if (wasRoom !== (category === 'room')) void loadPreview();
        } },
        h('span', { 'aria-hidden': 'true' }, c.mark), c.label)));
      catalog.replaceChildren(...SHOP_ITEMS.filter((i) => i.category === category).map((product) => {
        const card = h('button', { type: 'button', class: 'shop-product', 'aria-pressed': String(item.id === product.id),
          'aria-label': `Experimentar ${product.name}`, 'data-fk': `shop-item-${product.id}`, onClick: () => { item = product; render(); } },
          h('span', { class: 'shop-swatch', 'aria-hidden': 'true' }, shopArt(product)),
          h('b', {}, product.name), h('span', { class: 'shop-description' }, product.description),
          h('span', { class: 'shop-product-state' }, isEquipped(value, selected, product) ? '✓ Em uso' : value.owned.includes(product.id) ? 'No guarda-roupa' : 'Grátis'));
        card.style.setProperty('--item-color', product.color);
        return card;
      }));
      selectedName.textContent = item.name;
      selectedDescription.textContent = item.description;
      const equipped = isEquipped(value, selected, item);
      owned.textContent = equipped ? `Em uso${item.category === 'room' ? ' no escritório' : ` por ${NAMES[selected]}`}` : 'Prévia · experimente antes de equipar';
      action.textContent = equipped ? 'Equipado' : value.owned.includes(item.id) ? 'Equipar' : 'Resgatar grátis e equipar';
      action.disabled = equipped;
      applyPreview();
    });
  }
  async function loadPreview(): Promise<void> {
    const ticket = ++generation;
    preview?.dispose(); preview = undefined;
    stageMessage.hidden = false;
    stageMessage.textContent = 'Abrindo o provador…';
    try {
      const { createOfficeScene } = await import('./office-scene.js');
      if (closed || ticket !== generation) return;
      preview = createOfficeScene(stage, { preview: category === 'room' ? undefined : selected, onSelect: () => {}, onPosition: () => {}, onError: () => {
        stageMessage.hidden = false; stageMessage.textContent = 'O provador 3D está indisponível. Seus itens continuam salvos.';
      } });
      preview.setReducedMotion(appearance.reduceMotion || matchMedia('(prefers-reduced-motion: reduce)').matches);
      stageMessage.hidden = true;
      applyPreview();
    } catch { stageMessage.hidden = false; stageMessage.textContent = 'O provador 3D está indisponível. Você ainda pode escolher os itens.'; }
  }
  render(); void loadPreview();
}
