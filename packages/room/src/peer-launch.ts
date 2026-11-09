import { fileURLToPath } from 'node:url';
import type { McpServerSpec, ProviderId } from '@aio/core';

/** One teammate: which model answers when the lead asks, and at what effort. */
export interface TeamMember {
  model?: string;
  effort?: string;
}
export type Team = Partial<Record<ProviderId, TeamMember>>;

export interface PeerServerLaunch {
  /** Optional per-run visual activity journal, owned by the desktop app. */
  activityFile?: string;
  /** When this file disappears, the desktop run has stopped. */
  leaseFile?: string;
  /**
   * One JSON line per consultation (who answered and what it used). The peer server is another process, so this file
   * is how the app learns what the colleagues spent; the room folds it into its usage after each turn.
   */
  usageFile?: string;
  /** Who the lead may consult, with the model each one uses. Omitted: everyone else, on their default model. */
  team?: Team;
  /** Most asks one model may make during one turn; a loop of models consulting each other would burn quota. */
  maxAsks?: number;
  /** Override the server's entry file (defaults to the one next to this module). */
  entry?: string;
}

export const ROOM_SERVER_NAME = 'room';

export interface PeerServerSpecInput extends Omit<PeerServerLaunch, 'team'> {
  team?: Team;
  self: ProviderId;
  peers: ProviderId[];
  transcriptFile: string;
  cwd: string;
  /** The lead may use the web, so the colleagues it consults may too. */
  web?: boolean;
}

/**
 * The `room` MCP server for one model. The config it ends up in is a file the model could read, so it carries only
 * paths and names, never credentials. The server cannot be asked for database access either: it knows nothing of it.
 */
export function peerServerSpec(input: PeerServerSpecInput): McpServerSpec {
  const ext = import.meta.url.endsWith('.ts') ? 'ts' : 'js';
  const entry = input.entry ?? fileURLToPath(new URL(`./peer-main.${ext}`, import.meta.url));
  // When running from source (tsx), the entry is a .ts file that plain node cannot load.
  const fromSource = entry.endsWith('.ts');
  return {
    name: ROOM_SERVER_NAME,
    command: process.execPath,
    args: fromSource ? ['--import', import.meta.resolve('tsx'), entry] : [entry],
    env: {
      AIO_ROOM_FILE: input.transcriptFile,
      AIO_ROOM_SELF: input.self,
      AIO_ROOM_PEERS: input.peers.join(','),
      AIO_ROOM_CWD: input.cwd,
      AIO_ROOM_MAX_ASKS: String(input.maxAsks ?? 6),
      ...(input.activityFile ? { AIO_ROOM_ACTIVITY_FILE: input.activityFile } : {}),
      ...(input.leaseFile ? { AIO_ROOM_LEASE_FILE: input.leaseFile } : {}),
      ...(input.usageFile ? { AIO_ROOM_USAGE_FILE: input.usageFile } : {}),
      ...(input.web ? { AIO_ROOM_WEB: '1' } : {}),
      ...(input.team ? { AIO_ROOM_TEAM: JSON.stringify(input.team) } : {}),
      // Inside Electron the "node" to run is the app binary itself, which must be told to behave as plain node.
      ...(process.versions.electron ? { ELECTRON_RUN_AS_NODE: '1' } : {}),
    },
  };
}
