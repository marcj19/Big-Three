import { describe, expect, it } from 'vitest';
import { defaultWardrobe, equipItem, parseWardrobe, SHOP_ITEMS } from '../src/renderer/office-wardrobe.js';
import { officePose } from '../src/renderer/office-motion.js';

describe('local wardrobe', () => {
  it('equips an item on one character, retains ownership and restores it after reload', () => {
    const original = defaultWardrobe();
    const dressed = equipItem(original, 'gemini', SHOP_ITEMS.find((i) => i.id === 'outfit:hoodie')!);
    expect(original.looks.gemini.outfit).toBe('classic');
    expect(dressed.looks.gemini.outfit).toBe('hoodie');
    expect(dressed.looks.claude.outfit).toBe('classic');
    expect(dressed.owned).toContain('outfit:hoodie');
    expect(parseWardrobe(JSON.stringify(dressed))).toEqual(dressed);
  });
  it('rejects corrupt saves, unknown items and unowned equipment', () => {
    expect(parseWardrobe('{broken')).toEqual(defaultWardrobe());
    const saved = parseWardrobe(JSON.stringify({ looks: { claude: { outfit: 'space', hat: 'evil' } }, owned: ['unknown'], room: '__proto__' }));
    expect(saved).toEqual(defaultWardrobe());
  });
  it('applies room styles without changing clothing and does not duplicate ownership', () => {
    const item = SHOP_ITEMS.find((i) => i.id === 'room:lavender')!;
    const value = equipItem(equipItem(defaultWardrobe(), 'claude', item), 'codex', item);
    expect(value.room).toBe('lavender');
    expect(value.owned.filter((id) => id === item.id)).toHaveLength(1);
    expect(value.looks).toEqual(defaultWardrobe().looks);
  });
});
describe('activity choreography', () => {
  it('separates reading, editing and terminal gestures and leaves pauses between typing bursts', () => {
    expect(officePose('reading', 2, 0, false, 2).book).toBe(true);
    expect(officePose('editing', 2, 0, false, 2).pencil).toBe(true);
    expect(officePose('terminal', 2, 0, false, 2).terminal).toBe(true);
    const resting = officePose('writing', 4, 0, false, 4);
    expect(resting.leftY).toBe(.28); expect(resting.rightY).toBe(.28);
    expect(officePose('done', 30, 0, false, 5).rightY).toBe(.28);
  });
});
