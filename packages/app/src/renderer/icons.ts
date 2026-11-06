import type { Engine, ProviderId } from '../shared/api.js';

/**
 * Every icon lives once in a hidden sprite and is drawn with <use>. The model and database marks are simplified
 * originals in each product's colours, not the official logos: those are trademarks and are not bundled. To use the
 * official artwork, replace the matching <symbol> below.
 */

/** Rays of a burst, as one path: each ray is a short line from `inner` to `outer`, alternating long and short. */
function burst(cx: number, cy: number, rays: number, inner: number, long: number, short: number): string {
  let d = '';
  for (let k = 0; k < rays; k++) {
    const a = (k * 2 * Math.PI) / rays - Math.PI / 2;
    const outer = k % 2 === 0 ? long : short;
    const f = (n: number) => n.toFixed(2);
    d += `M${f(cx + Math.cos(a) * inner)} ${f(cy + Math.sin(a) * inner)}L${f(cx + Math.cos(a) * outer)} ${f(cy + Math.sin(a) * outer)}`;
  }
  return d;
}

const UI: Record<string, string> = {
  plus: '<path d="M12 5v14M5 12h14"/>',
  phone: '<rect x="7" y="2.5" width="10" height="19" rx="2"/><path d="M11 18.5h2"/>',
  file: '<path d="M6 3h8l4 4v14H6zM14 3v5h4M9 12h6m-6 4h6"/>',
  send: '<path d="M12 19V5M5 12l7-7 7 7"/>',
  stop: '<rect x="7" y="7" width="10" height="10" rx="2.5" fill="currentColor" stroke="none"/>',
  trash: '<path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3"/>',
  folder: '<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>',
  pencil: '<path d="M4 20h4L19 9l-4-4L4 16z"/><path d="M13.5 6.5l4 4"/>',
  bolt: '<path d="M13 3L5 14h6l-1 7 8-11h-6z"/>',
  eye: '<path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/>',
  eyeoff: '<path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/><path d="M4 4l16 16"/>',
  database: '<ellipse cx="12" cy="6" rx="8" ry="3"/><path d="M4 6v12c0 1.7 3.6 3 8 3s8-1.3 8-3V6"/><path d="M4 12c0 1.7 3.6 3 8 3s8-1.3 8-3"/>',
  check: '<path d="M5 12.5l4.5 4.5L19 7.5"/>',
  x: '<path d="M6 6l12 12M18 6L6 18"/>',
  refresh: '<path d="M20 11a8 8 0 1 0-2.3 5.7"/><path d="M20 5v6h-6"/>',
  branch: '<circle cx="7" cy="5" r="2.5"/><circle cx="7" cy="19" r="2.5"/><circle cx="17" cy="6" r="2.5"/><path d="M7 7.5v9m10-8c0 4.5-3 6-10 6"/>',
  sliders: '<path d="M4 7h9M19 7h1M4 17h1M11 17h9"/><circle cx="16" cy="7" r="2.5"/><circle cx="8" cy="17" r="2.5"/>',
  copy: '<rect x="9" y="9" width="11" height="11" rx="2.5"/><path d="M5 15V6.5A2.5 2.5 0 0 1 7.5 4H16"/>',
  chevron: '<path d="M6 9l6 6 6-6"/>',
  chat: '<path d="M4 6.5A2.5 2.5 0 0 1 6.5 4h11A2.5 2.5 0 0 1 20 6.5v7a2.5 2.5 0 0 1-2.5 2.5H10l-4.5 4v-4A2.5 2.5 0 0 1 4 13.5z"/>',
  swap: '<path d="M7 8h13l-3.5-3.5M17 16H4l3.5 3.5"/>',
  plan: '<path d="M9 6h11M9 12h11M9 18h11"/><path d="M4 6l1 1 2-2M4 12l1 1 2-2M4 18l1 1 2-2"/>',
  users: '<circle cx="9" cy="8" r="3"/><path d="M3 20c0-3.3 2.7-6 6-6s6 2.7 6 6"/><circle cx="17.5" cy="9" r="2.5"/><path d="M16.5 14.2c2.8.3 4.5 2.5 4.5 5.3"/>',
  alert: '<path d="M12 3.5l9.5 16.5h-19z"/><path d="M12 10v4.5M12 17.5h.01"/>',
  info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v5M12 8h.01"/>',
  shield: '<path d="M12 3l8 3v6c0 4.5-3.2 7.8-8 9-4.8-1.2-8-4.5-8-9V6z"/>',
  terminal: '<path d="M5 7l5 5-5 5M12 18h7"/>',
  menu: '<path d="M4 6h16M4 12h16M4 18h16"/>',
  arrow: '<path d="M5 12h14M13 6l6 6-6 6"/>',
  spinner: '<path d="M12 3a9 9 0 1 0 9 9" />',
  sparkle: '<path d="M12 3c.6 4.8 3.2 7.4 8 8-4.8.6-7.4 3.2-8 8-.6-4.8-3.2-7.4-8-8 4.8-.6 7.4-3.2 8-8z"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 3v2M12 19v2M3 12h2M19 12h2M5.6 5.6L7 7M17 17l1.4 1.4M5.6 18.4L7 17M17 7l1.4-1.4"/>',
  moon: '<path d="M20 14.5A8 8 0 0 1 9.5 4 8 8 0 1 0 20 14.5z"/>',
  contrast: '<circle cx="12" cy="12" r="9"/><path d="M12 3v18" /><path d="M12 3a9 9 0 0 1 0 18z" fill="currentColor"/>',
};

const BRAND = `
<linearGradient id="gloss" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#fff" stop-opacity="0.34"/><stop offset="0.55" stop-color="#fff" stop-opacity="0"/></linearGradient>
<linearGradient id="g-claude" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#ee9f78"/><stop offset="1" stop-color="#c05831"/></linearGradient>
<linearGradient id="g-gemini-tile" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#4658d4"/><stop offset="1" stop-color="#171b4d"/></linearGradient>
<linearGradient id="g-gemini" x1="4" y1="3" x2="20" y2="21" gradientUnits="userSpaceOnUse"><stop offset="0" stop-color="#8ab4ff"/><stop offset="0.55" stop-color="#c3a4f0"/><stop offset="1" stop-color="#ff9aa8"/></linearGradient>
<linearGradient id="g-codex" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#3fdcb0"/><stop offset="1" stop-color="#087056"/></linearGradient>
<linearGradient id="g-pg" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#4f86b8"/><stop offset="1" stop-color="#27527d"/></linearGradient>
<linearGradient id="g-my" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#14a0bd"/><stop offset="1" stop-color="#005b73"/></linearGradient>
<linearGradient id="g-or" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#ec6454"/><stop offset="1" stop-color="#aa352a"/></linearGradient>
<symbol id="b-claude" viewBox="0 0 32 32"><rect width="32" height="32" fill="url(#g-claude)"/><path d="${burst(16, 16, 12, 3.6, 10.6, 8.4)}" stroke="#fff" stroke-width="2.3" stroke-linecap="round" fill="none"/><rect width="32" height="32" fill="url(#gloss)"/></symbol>
<symbol id="b-gemini" viewBox="0 0 32 32"><rect width="32" height="32" fill="url(#g-gemini-tile)"/><path transform="translate(4 4)" d="M12 2C12.9 7.7 16.3 11.1 22 12c-5.7.9-9.1 4.3-10 10-.9-5.7-4.3-9.1-10-10C7.7 11.1 11.1 7.7 12 2z" fill="url(#g-gemini)"/><rect width="32" height="32" fill="url(#gloss)"/></symbol>
<symbol id="b-codex" viewBox="0 0 32 32"><rect width="32" height="32" fill="url(#g-codex)"/><path d="M10.5 11.5l5 4.5-5 4.5M17.5 21h5" stroke="#fff" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" fill="none"/><rect width="32" height="32" fill="url(#gloss)"/></symbol>
<symbol id="db-postgres" viewBox="0 0 32 32"><rect width="32" height="32" fill="url(#g-pg)"/><path d="M8 9.5v13c0 1.9 3.6 3.3 8 3.3s8-1.4 8-3.3v-13z" fill="#fff"/><ellipse cx="16" cy="9.5" rx="8" ry="3.3" fill="#cfe1f4"/><path d="M8 14.6c0 1.9 3.6 3.3 8 3.3s8-1.4 8-3.3M8 19.2c0 1.9 3.6 3.3 8 3.3s8-1.4 8-3.3" stroke="#336791" stroke-width="1.5" fill="none"/><rect width="32" height="32" fill="url(#gloss)"/></symbol>
<symbol id="db-mysql" viewBox="0 0 32 32"><rect width="32" height="32" fill="url(#g-my)"/><path d="M8 9.5v13c0 1.9 3.6 3.3 8 3.3s8-1.4 8-3.3v-13z" fill="#fff"/><ellipse cx="16" cy="9.5" rx="8" ry="3.3" fill="#bfe3ea"/><path d="M8 17.5c2.7-3.2 5.3-3.2 8 0s5.3 3.2 8 0" stroke="#f29111" stroke-width="2.8" stroke-linecap="round" fill="none"/><rect width="32" height="32" fill="url(#gloss)"/></symbol>
<symbol id="db-oracle" viewBox="0 0 32 32"><rect width="32" height="32" fill="url(#g-or)"/><rect x="5.5" y="10.5" width="21" height="11" rx="5.5" fill="none" stroke="#fff" stroke-width="3.6"/><rect width="32" height="32" fill="url(#gloss)"/></symbol>`;

export function installIcons(): void {
  const symbols = Object.entries(UI)
    .map(([id, body]) => `<symbol id="i-${id}" viewBox="0 0 24 24">${body}</symbol>`)
    .join('');
  const doc = new DOMParser().parseFromString(
    `<svg xmlns="http://www.w3.org/2000/svg" width="0" height="0" aria-hidden="true" focusable="false"><defs>${BRAND}</defs>${symbols}</svg>`,
    'image/svg+xml',
  );
  const sprite = document.importNode(doc.documentElement, true);
  sprite.setAttribute('class', 'sprite');
  document.body.prepend(sprite);
}

const SVG = 'http://www.w3.org/2000/svg';
/** The outer viewBox and the <use> size are spelled out: left to defaults, the symbol rendered at half size. */
function use(id: string, cls: string, box: number): SVGSVGElement {
  const svg = document.createElementNS(SVG, 'svg');
  svg.setAttribute('viewBox', `0 0 ${box} ${box}`);
  svg.setAttribute('class', cls);
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('focusable', 'false');
  const u = document.createElementNS(SVG, 'use');
  u.setAttribute('href', `#${id}`);
  u.setAttribute('width', String(box));
  u.setAttribute('height', String(box));
  svg.append(u);
  return svg;
}

export type IconName = keyof typeof UI;
/** A decorative interface icon; the control around it carries the accessible name. */
export const icon = (name: IconName, extra = ''): SVGSVGElement => use(`i-${name}`, `i ${extra}`.trim(), 24);
export const providerMark = (id: ProviderId): SVGSVGElement => use(`b-${id}`, 'logo', 32);
export const engineMark = (engine: Engine): SVGSVGElement => use(`db-${engine}`, 'logo', 32);
