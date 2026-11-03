import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { z } from 'zod';
import type { ConnectionProfile, Engine, SecretStore } from './types.js';

const DEFAULT_PORTS: Record<Engine, number> = { postgres: 5432, mysql: 3306, oracle: 1521 };

export const CONNECTION_NAME = /^[A-Za-z0-9_-]{1,64}$/;

export const ProfileSchema = z.object({
  name: z.string().regex(CONNECTION_NAME, 'name must be 1-64 chars of letters, digits, _ or -'),
  engine: z.enum(['postgres', 'mysql', 'oracle']),
  host: z.string().min(1),
  port: z.number().int().positive().optional(),
  database: z.string().min(1),
  user: z.string().min(1),
  ssl: z.boolean().optional(),
  allowedFunctions: z.array(z.string()).optional(),
});

/**
 * Where connection profiles, the audit log and conversations live: %APPDATA% on Windows, Application Support on
 * macOS, XDG_CONFIG_HOME (or ~/.config) elsewhere. `AIO_CONFIG_DIR` overrides it. The folder name predates the
 * project's public name and is kept so existing data is not orphaned.
 */
export function configDir(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform, home = os.homedir()): string {
  if (env.AIO_CONFIG_DIR) return env.AIO_CONFIG_DIR;
  const base =
    platform === 'win32'
      ? (env.APPDATA ?? path.join(home, 'AppData', 'Roaming'))
      : platform === 'darwin'
        ? path.join(home, 'Library', 'Application Support')
        : (env.XDG_CONFIG_HOME ?? path.join(home, '.config'));
  return path.join(base, 'ai-orchestrator');
}

export const profilesFile = (dir = configDir()) => path.join(dir, 'connections.json');

/** Validates and writes the profiles (never passwords) atomically, so a crash cannot leave a half-written file. */
export async function saveProfiles(profiles: ConnectionProfile[], file = profilesFile()): Promise<void> {
  const parsed = z.array(ProfileSchema).parse(profiles);
  const names = new Set<string>();
  for (const p of parsed) {
    if (names.has(p.name)) throw new Error(`Duplicate connection name: ${p.name}`);
    names.add(p.name);
  }
  await mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  await writeFile(tmp, JSON.stringify(parsed, null, 2));
  await rename(tmp, file);
}

/** Keeps only the named profiles (comma-separated). An empty or missing list keeps everything. */
export function selectProfiles(profiles: ConnectionProfile[], names: string | undefined): ConnectionProfile[] {
  const wanted = (names ?? '').split(',').map((n) => n.trim()).filter(Boolean);
  return wanted.length === 0 ? profiles : profiles.filter((p) => wanted.includes(p.name));
}

/** Reads non-secret connection profiles. Passwords are never part of this file. */
export async function loadProfiles(file = profilesFile()): Promise<ConnectionProfile[]> {
  let raw: string;
  try {
    raw = await readFile(file, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }
  const parsed = z.array(ProfileSchema).parse(JSON.parse(raw));
  const names = new Set<string>();
  return parsed.map((p) => {
    if (names.has(p.name)) throw new Error(`Duplicate connection name: ${p.name}`);
    names.add(p.name);
    return { ...p, port: p.port ?? DEFAULT_PORTS[p.engine] };
  });
}

/**
 * Reads passwords from this process's own environment (AIO_SECRET_<NAME>).
 * The desktop app is expected to start the broker with these set and to start every
 * model CLI with a sanitized environment that omits them.
 */
export class EnvSecretStore implements SecretStore {
  constructor(private readonly env: NodeJS.ProcessEnv = process.env) {}

  async get(connectionName: string): Promise<string | undefined> {
    return this.env[`AIO_SECRET_${connectionName.toUpperCase().replace(/[^A-Z0-9]/g, '_')}`];
  }
}
