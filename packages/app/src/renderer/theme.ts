export type ThemeChoice = 'auto' | 'light' | 'dark';
export const ACCENTS = { blue: 'Azul', graphite: 'Grafite', green: 'Verde', violet: 'Violeta' } as const;
export type AccentChoice = keyof typeof ACCENTS;
export type SidebarWidth = 'narrow' | 'medium' | 'wide';
export type SidebarDensity = 'comfortable' | 'compact';
export interface Appearance {
  theme: ThemeChoice;
  /** Index into TEXT_SIZES. */
  textSize: number;
  reduceMotion: boolean;
  office3d: boolean;
  accent: AccentChoice;
  sidebarWidth: SidebarWidth;
  sidebarDensity: SidebarDensity;
  showSidebarUsage: boolean;
}

export const TEXT_SIZES = [14, 16, 18, 20];
export const TEXT_SIZE_LABEL = ['Pequeno', 'Normal', 'Grande', 'Muito grande'];
const KEY = 'aio.appearance.v1';

export const appearance: Appearance = {
  theme: 'auto', textSize: 1, reduceMotion: false, office3d: false,
  accent: 'blue', sidebarWidth: 'medium', sidebarDensity: 'comfortable', showSidebarUsage: true,
};

export function loadAppearance(): void {
  try {
    const saved = JSON.parse(localStorage.getItem(KEY) ?? 'null') as Partial<Appearance> | null;
    if (saved) Object.assign(appearance, saved);
  } catch {
    /* storage unavailable: defaults */
  }
  applyAppearance();
  matchMedia('(prefers-color-scheme: dark)').addEventListener('change', applyAppearance);
}

export function applyAppearance(): void {
  const root = document.documentElement;
  const dark = appearance.theme === 'dark' || (appearance.theme === 'auto' && matchMedia('(prefers-color-scheme: dark)').matches);
  root.dataset.theme = dark ? 'dark' : 'light';
  root.dataset.accent = appearance.accent;
  root.dataset.sidebarWidth = appearance.sidebarWidth;
  root.dataset.sidebarDensity = appearance.sidebarDensity;
  root.dataset.sidebarUsage = appearance.showSidebarUsage ? 'show' : 'hide';
  root.style.fontSize = `${TEXT_SIZES[appearance.textSize] ?? 16}px`;
  if (appearance.reduceMotion) root.dataset.motion = 'reduce';
  else delete root.dataset.motion;
  root.classList.toggle('office-mode', appearance.office3d === true);
  window.dispatchEvent(new Event('aio:appearance'));
}

export function setAppearance(change: Partial<Appearance>): void {
  Object.assign(appearance, change);
  applyAppearance();
  try {
    localStorage.setItem(KEY, JSON.stringify(appearance));
  } catch {
    /* ignore */
  }
}
