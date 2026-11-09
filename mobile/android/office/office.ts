import { createOfficeScene, type OfficeScene } from '../../../packages/app/src/renderer/office-scene.js';
import { ACTIVE_ACTIVITIES, STATUS_LABELS, type OfficeStatus } from '../../../packages/app/src/renderer/office-model.js';
import type { ProviderId } from '../../../packages/app/src/shared/api.js';

const providers = ['claude', 'gemini', 'codex'] as const;
const names = { claude: 'Claude', gemini: 'Gemini', codex: 'Codex' };
const statuses: Record<ProviderId, OfficeStatus> = { claude: 'idle', gemini: 'idle', codex: 'idle' };
const room = document.querySelector<HTMLElement>('#room')!;
const badges = Object.fromEntries(providers.map((id) => {
  const element = document.createElement('span');
  element.className = 'badge';
  element.hidden = true;
  element.textContent = names[id];
  room.append(element);
  return [id, element];
})) as Record<ProviderId, HTMLSpanElement>;
let scene: OfficeScene | undefined;
const motion = matchMedia('(prefers-reduced-motion: reduce)');

function fallback(): void {
  scene?.dispose();
  scene = undefined;
  room.classList.remove('ready');
  for (const id of providers) badges[id].hidden = true;
}

try {
  scene = createOfficeScene(room, {
    onSelect(id) { scene?.select(id); },
    onPosition(id, x, y) { badges[id].style.left = `${x}%`; badges[id].style.top = `${y}%`; },
    onError: fallback,
  });
  scene.setReducedMotion(motion.matches);
  room.classList.add('ready');
  for (const id of providers) badges[id].hidden = false;
} catch { fallback(); }

Object.assign(window, {
  bigThreeOffice(snapshot: string) {
    const agents = JSON.parse(snapshot) as { id: ProviderId; status: OfficeStatus }[];
    for (const id of providers) {
      const status = agents.find((entry) => entry.id === id)?.status;
      statuses[id] = status && Object.hasOwn(STATUS_LABELS, status) ? status : 'idle';
      const active = String(ACTIVE_ACTIVITIES.includes(statuses[id]));
      badges[id].dataset.active = active;
      room.querySelector<HTMLElement>(`[data-agent="${id}"]`)!.dataset.active = active;
    }
    scene?.update(statuses);
  },
  bigThreePause(paused: boolean) {
    document.body.dataset.paused = String(paused);
    scene?.setPaused(paused);
  },
});
motion.addEventListener('change', () => scene?.setReducedMotion(motion.matches));
window.addEventListener('pagehide', () => scene?.dispose(), { once: true });
