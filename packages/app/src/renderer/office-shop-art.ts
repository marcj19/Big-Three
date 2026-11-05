import type { ShopItem } from './office-wardrobe.js';

/** Small local illustrations, matching the actual wardrobe geometry. */
export function shopArt(item: ShopItem): SVGSVGElement {
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('viewBox', '0 0 160 100'); svg.setAttribute('aria-hidden', 'true');
  function shape(tag: string, attrs: Record<string, string | number>) {
    const node = document.createElementNS(ns, tag);
    for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, String(value));
    svg.append(node); return node;
  }
  const path = (d: string, fill = item.color, stroke = '#344139', width = 2) => shape('path', { d, fill, stroke, 'stroke-width': width, 'stroke-linecap': 'round', 'stroke-linejoin': 'round' });
  const rect = (x: number, y: number, w: number, h: number, fill: string, r = 5) => shape('rect', { x, y, width: w, height: h, rx: r, fill });
  const circle = (cx: number, cy: number, r: number, fill: string) => shape('circle', { cx, cy, r, fill });
  shape('ellipse', { cx: 80, cy: 88, rx: 38, ry: 5, fill: item.color, opacity: .14 });
  if (item.category === 'outfit') {
    path('M58 29 42 36 32 59 47 65 53 52 53 81 107 81 107 52 113 65 128 59 118 36 102 29 93 22 67 22Z');
    if (item.value === 'hoodie') {
      path('M65 27Q58 3 80 6Q102 3 95 27Q80 39 65 27Z', item.color);
      path('M67 63 64 74 96 74 93 63Z', 'none', '#ffffff8c', 2);
      path('M74 34 73 51M86 34 87 51', 'none', '#faf5e8', 2);
    } else if (item.value === 'blazer') {
      path('M68 23 80 49 92 23Z', '#fff6e8');
      path('M58 29 71 23 80 50 64 42 69 36Z', item.color);
      path('M102 29 89 23 80 50 96 42 91 36Z', item.color);
      path('M77 32 83 32 85 51 80 56 75 51Z', '#c8866d', 'none');
      circle(80, 65, 2, '#f6ebd8');
    } else if (item.value === 'space') {
      rect(64, 38, 32, 21, '#91b5ce'); rect(54, 66, 52, 8, '#687d83', 1);
      for (const x of [38, 112]) rect(x, 28, 10, 45, '#b5c6cc');
      circle(72, 48, 3, '#fff'); circle(86, 48, 3, '#d8a167');
    } else path('M68 23Q80 39 92 23', 'none', '#f7ead8', 4);
  } else if (item.id === 'hat:cap') {
    path('M45 63Q43 19 80 19Q114 19 113 63Z');
    path('M55 63Q89 56 126 65Q132 79 91 76L55 72Z', item.color);
    path('M80 23 80 54', 'none', '#f4f5e77a', 2);
  } else if (item.id === 'hat:beanie') {
    path('M49 65Q46 20 80 20Q114 20 111 65Z');
    rect(45, 61, 70, 17, '#b46e60'); circle(80, 14, 10, '#f4e4cd');
    for (const x of [58, 69, 80, 91, 102]) path(`M${x} 36 ${x} 58`, 'none', '#fff4df60', 2);
  } else if (item.id === 'hat:sprout') {
    path('M80 77 80 39', 'none', '#568c70', 5);
    path('M79 54Q40 59 44 26Q78 24 79 54Z', '#8ab779');
    path('M81 43Q81 13 117 15Q121 46 81 43Z', '#a6c98c');
  } else if (item.id === 'accessory:glasses') {
    for (const cx of [54, 106]) shape('circle', { cx, cy: 50, r: 21, fill: '#ffffff40', stroke: item.color, 'stroke-width': 5 });
    path('M75 47Q80 42 85 47M31 43 22 39M129 43 138 39', 'none', item.color, 5);
    path('M45 40 51 34M97 40 103 34', 'none', '#ffffffb3', 3);
  } else if (item.id === 'accessory:headphones') {
    path('M42 58V45Q42 10 80 10Q118 10 118 45V58', 'none', item.color, 10);
    rect(33, 47, 23, 34, item.color, 9); rect(104, 47, 23, 34, item.color, 9);
    rect(47, 52, 7, 25, '#344139', 3); rect(106, 52, 7, 25, '#344139', 3);
  } else if (item.category === 'room') {
    path('M29 63 79 85 132 62 82 39Z', item.color, 'none');
    path('M29 63V23L81 44V85Z', '#eee4d4', 'none');
    path('M81 44 132 23V62L81 85Z', '#f7f0e2', 'none');
    path('M92 46V31L119 22V37Z', '#b9dfe3', 'none');
    path('M58 61 83 70 107 59 82 50Z', '#c69e7e', 'none');
    path('M61 63V75M102 61V72', 'none', '#9f8c76', 3);
  } else {
    circle(80, 48, 27, item.color); circle(71, 45, 2.5, '#485649'); circle(89, 45, 2.5, '#485649');
    path('M70 56Q80 67 90 56', 'none', '#485649', 3);
  }
  return svg;
}
