import { mkdtemp, readFile, rmdir, stat, unlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { z } from 'zod';
import type { PeerActivity } from '@aio/room';

const provider = z.enum(['claude', 'gemini', 'codex']);
const schema = z.object({ self: provider, peer: provider, activity: z.enum(['thinking', 'writing', 'tool', 'done', 'error', 'cancelled']), tool: z.string().max(160).optional() });
export function parsePeerActivity(line: string): PeerActivity | undefined {
  try { const result = schema.safeParse(JSON.parse(line)); return result.success && result.data.self !== result.data.peer ? result.data : undefined; } catch { return undefined; }
}
/** A bounded, per-run bridge from the MCP process. It carries visual state only. */
export async function watchPeerActivity(emit: (event: PeerActivity) => void): Promise<{ file: string; close(): Promise<void> }> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'aio-peer-activity-'));
  const file = path.join(dir, 'activity.jsonl');
  await writeFile(file, '', { mode: 0o600 });
  let offset = 0;
  let pending: Promise<void> | undefined;
  const drain = async () => {
    try {
      if ((await stat(file)).size > 1_000_000) return;
      const data = await readFile(file, 'utf8');
      const end = data.lastIndexOf('\n') + 1;
      if (end <= offset) return;
      const fresh = data.slice(offset, end); offset = end;
      for (const line of fresh.split('\n')) { const event = parsePeerActivity(line); if (event) emit(event); }
    } catch { /* A missing or invalid cosmetic journal cannot fail the run. */ }
  };
  const timer = setInterval(() => { if (!pending) pending = drain().finally(() => { pending = undefined; }); }, 120);
  timer.unref();
  return { file, async close() {
    clearInterval(timer); await pending; await drain();
    await unlink(file).catch(() => {}); await rmdir(dir).catch(() => {});
  } };
}
