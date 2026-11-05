import type { OfficeStatus } from './office-model.js';

/** Timed gestures have long rests and per-character offsets, rather than three synchronized loops. */
export function officePose(status: OfficeStatus, seconds: number, index: number, calm: boolean, elapsed: number) {
  const t = seconds / (calm ? 1.45 : 1);
  const phase = t + index * 3.7;
  const unavailable = ['offline', 'signed-out', 'checking', 'away'].includes(status);
  const burst = phase % 5.8 < 2.1;
  const pose = { headZ: 0, headY: 0, bodyY: unavailable ? 0 : Math.sin(phase * .8) * .009,
    leftY: .28, rightY: .28, leftZ: .44, rightZ: .44, blink: !unavailable && phase % 8.7 < .12, book: false, pencil: false, terminal: false, database: false };
  if (unavailable) return pose;
  switch (status) {
    case 'thinking': pose.headZ = -.08; pose.rightY = .85; pose.rightZ = .28; break;
    case 'reading': case 'reviewing':
      pose.book = true; pose.headZ = -.04; pose.headY = Math.sin(phase * .6) * .05;
      pose.leftY = .5; pose.rightY = .5; pose.leftZ = pose.rightZ = .62; break;
    case 'editing':
      pose.pencil = true; pose.rightY = .4 + (burst ? Math.sin(phase * 9) * .025 : 0); pose.rightZ = .64; break;
    case 'terminal': case 'writing':
      pose.terminal = status === 'terminal';
      pose.leftZ = pose.rightZ = .68;
      if (burst) { pose.leftY += Math.sin(phase * 12) * .035; pose.rightY += Math.sin(phase * 12 + Math.PI) * .035; }
      break;
    case 'consulting': pose.headY = index === 2 ? -.32 : .32; pose.rightY = .88; pose.rightZ = .12; break;
    case 'searching': pose.headY = Math.sin(phase * .75) * .09; pose.rightZ = .65; break;
    case 'database': pose.database = true; pose.headZ = -.035; break;
    case 'tool': pose.rightZ = .65; break;
    case 'done':
      if (elapsed < 2) { pose.rightY = 1.06; pose.rightZ = .23; pose.headZ = Math.sin(elapsed * 7) * .035; }
      break;
    case 'error': case 'limited': pose.headZ = -.1; break;
    default:
      // A little stretch, at most once every 24 (35 in calm mode) seconds.
      if (phase % 24 < 1.3) pose.leftY = .28 + Math.sin((phase % 24) / 1.3 * Math.PI) * .3;
  }
  return pose;
}
