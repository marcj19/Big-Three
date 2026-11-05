import type { ProviderId } from '../shared/api.js';

export type Outfit = 'classic' | 'hoodie' | 'blazer' | 'space';
export type Hat = 'none' | 'beanie' | 'cap' | 'sprout';
export type Accessory = 'none' | 'glasses' | 'headphones';
export type RoomStyle = 'sage' | 'peach' | 'lavender';
export interface Look { outfit: Outfit; hat: Hat; accessory: Accessory }
export interface Wardrobe { looks: Record<ProviderId, Look>; room: RoomStyle; owned: string[]; pace: 'calm' | 'regular' }
export type ShopCategory = 'outfit' | 'hat' | 'accessory' | 'room';
export interface ShopItem { id: string; category: ShopCategory; value: string; name: string; description: string; color: string; mark: string }

export const SHOP_ITEMS: readonly ShopItem[] = [
  { id: 'outfit:classic', category: 'outfit', value: 'classic', name: 'Do jeitinho de sempre', description: 'As cores originais de cada personagem.', color: '#d8b899', mark: '◒' },
  { id: 'outfit:hoodie', category: 'outfit', value: 'hoodie', name: 'Moletom de ideias', description: 'Conforto para aquela sessão de código.', color: '#718eac', mark: '◡' },
  { id: 'outfit:blazer', category: 'outfit', value: 'blazer', name: 'Reunião importante', description: 'Blazer, camisa e um ar de quem resolveu.', color: '#525b7b', mark: '⋈' },
  { id: 'outfit:space', category: 'outfit', value: 'space', name: 'Missão espacial', description: 'Macacão e mochila para explorar ideias.', color: '#e6dfd0', mark: '✦' },
  { id: 'hat:none', category: 'hat', value: 'none', name: 'Cabeça livre', description: 'Espaço de sobra para pensar.', color: '#e5d9c6', mark: '○' },
  { id: 'hat:beanie', category: 'hat', value: 'beanie', name: 'Gorro de inverno', description: 'Com pompom. Porque sim.', color: '#c77869', mark: '◕' },
  { id: 'hat:cap', category: 'hat', value: 'cap', name: 'Boné de folga', description: 'Um toque casual entre uma tarefa e outra.', color: '#83a18b', mark: '◓' },
  { id: 'hat:sprout', category: 'hat', value: 'sprout', name: 'Uma ideia brotou', description: 'Uma plantinha para cultivar boas ideias.', color: '#78a365', mark: '⚘' },
  { id: 'accessory:none', category: 'accessory', value: 'none', name: 'Sem acessórios', description: 'O sorriso já dá conta.', color: '#d9d4c8', mark: '·' },
  { id: 'accessory:glasses', category: 'accessory', value: 'glasses', name: 'Olhar de especialista', description: 'Óculos redondos, ideias bem focadas.', color: '#475566', mark: '◎' },
  { id: 'accessory:headphones', category: 'accessory', value: 'headphones', name: 'Modo concentração', description: 'Fones para entrar no ritmo.', color: '#ad92b9', mark: '∩' },
  { id: 'room:sage', category: 'room', value: 'sage', name: 'Jardim de ideias', description: 'Sálvia, madeira clara e luz da manhã.', color: '#9ab6a1', mark: '▦' },
  { id: 'room:peach', category: 'room', value: 'peach', name: 'Fim de tarde', description: 'Pêssego e terracota para um clima acolhedor.', color: '#d9ac94', mark: '◐' },
  { id: 'room:lavender', category: 'room', value: 'lavender', name: 'Ateliê lilás', description: 'Lavanda e azul para imaginar mais longe.', color: '#aba5c7', mark: '✧' },
];
export const ROOM_PALETTES: Record<RoomStyle, { floor: string; wall: string; rug: string; background: string }> = {
  sage: { floor: '#9ab6a1', wall: '#f0e8da', rug: '#d5d5bf', background: '#e5e8dc' },
  peach: { floor: '#c6a897', wall: '#f3deca', rug: '#ddc8ac', background: '#f2e1d2' },
  lavender: { floor: '#a6adc5', wall: '#e5e0f0', rug: '#cbc3de', background: '#e8e3f1' },
};
const KEY = 'aio.office.wardrobe.v1';
export function defaultWardrobe(): Wardrobe {
  const look = (): Look => ({ outfit: 'classic', hat: 'none', accessory: 'none' });
  return { looks: { claude: look(), gemini: look(), codex: look() }, room: 'sage', owned: ['outfit:classic', 'hat:none', 'accessory:none', 'room:sage'], pace: 'calm' };
}
export function parseWardrobe(raw: string | null): Wardrobe {
  const result = defaultWardrobe();
  try {
    const saved = JSON.parse(raw ?? 'null') as Partial<Wardrobe> | null;
    if (!saved || typeof saved !== 'object') return result;
    result.owned = [...new Set([...result.owned, ...(Array.isArray(saved.owned) ? saved.owned.filter((id) => SHOP_ITEMS.some((item) => item.id === id)) : [])])];
    if (saved.pace === 'regular') result.pace = 'regular';
    if (SHOP_ITEMS.some((i) => i.id === `room:${saved.room}` && result.owned.includes(i.id))) result.room = saved.room!;
    for (const provider of ['claude', 'gemini', 'codex'] as const) for (const category of ['outfit', 'hat', 'accessory'] as const) {
      const value = saved.looks?.[provider]?.[category];
      if (SHOP_ITEMS.some((i) => i.id === `${category}:${value}` && result.owned.includes(i.id))) {
        (result.looks[provider] as unknown as Record<string, string>)[category] = value!;
      }
    }
  } catch { /* A malformed or old save falls back to the original characters. */ }
  return result;
}
export function loadWardrobe(): Wardrobe { try { return parseWardrobe(localStorage.getItem(KEY)); } catch { return defaultWardrobe(); } }
export function saveWardrobe(value: Wardrobe): void { try { localStorage.setItem(KEY, JSON.stringify(value)); } catch { /* Session-only on devices without storage. */ } }
export function equipItem(current: Wardrobe, provider: ProviderId, item: ShopItem): Wardrobe {
  const next = structuredClone(current);
  if (!next.owned.includes(item.id)) next.owned.push(item.id);
  if (item.category === 'room') next.room = item.value as RoomStyle;
  else (next.looks[provider] as unknown as Record<string, string>)[item.category] = item.value;
  return next;
}
export function isEquipped(value: Wardrobe, provider: ProviderId, item: ShopItem): boolean {
  return (item.category === 'room' ? value.room : value.looks[provider][item.category]) === item.value;
}
