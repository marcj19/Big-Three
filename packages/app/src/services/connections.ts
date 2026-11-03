import { Broker, CONNECTION_NAME, loadProfiles, profilesFile, saveProfiles, type ConnectionProfile, type WritableSecretStore } from '@aio/db-broker';
import type { ConnectionInput, ConnectionTest, ConnectionView } from '../shared/api.js';

/** Turns a zod error into one readable line for the form. */
function readable(err: unknown): Error {
  const issues = (err as { issues?: { path: (string | number)[]; message: string }[] }).issues;
  if (!issues?.length) return err instanceof Error ? err : new Error('Invalid connection');
  const first = issues[0]!;
  // The profile is validated as a one-item list; the item's index means nothing to the person filling the form.
  const path = first.path.filter((p) => typeof p === 'string');
  return new Error(path.length ? `${path.join('.')}: ${first.message}` : first.message);
}

/**
 * Connection profiles live in connections.json (no passwords); passwords only ever go to the system vault, from
 * the window and never back to it.
 */
export class ConnectionService {
  private readonly file: string;

  constructor(
    configDir: string,
    private readonly vault: WritableSecretStore,
  ) {
    this.file = profilesFile(configDir);
  }

  profiles(): Promise<ConnectionProfile[]> {
    return loadProfiles(this.file);
  }

  private async hasPassword(name: string): Promise<boolean> {
    try {
      return await this.vault.has(name);
    } catch {
      return false; // no usable vault on this machine: the form should simply show "no password"
    }
  }

  async list(): Promise<ConnectionView[]> {
    const profiles = await this.profiles();
    return Promise.all(
      profiles.map(async (p) => ({
        name: p.name,
        engine: p.engine,
        host: p.host,
        port: p.port,
        database: p.database,
        user: p.user,
        ssl: p.ssl,
        hasPassword: await this.hasPassword(p.name),
      })),
    );
  }

  /** Adds or replaces a profile by name, keeping the ones the window does not edit (such as allowedFunctions). */
  async save(input: ConnectionInput): Promise<void> {
    const existing = await this.profiles();
    const previous = existing.find((p) => p.name === input.name);
    const next: ConnectionProfile = { ...previous, ...input, port: input.port ?? undefined } as ConnectionProfile;
    try {
      await saveProfiles([...existing.filter((p) => p.name !== input.name), next], this.file);
    } catch (err) {
      throw readable(err);
    }
  }

  async remove(name: string): Promise<void> {
    await saveProfiles((await this.profiles()).filter((p) => p.name !== name), this.file);
    await this.vault.delete(name).catch(() => undefined);
  }

  private checkName(name: string): void {
    if (!CONNECTION_NAME.test(name)) throw new Error('Invalid connection name');
  }

  async setPassword(name: string, password: string): Promise<void> {
    this.checkName(name);
    if (!(await this.profiles()).some((p) => p.name === name)) throw new Error('Save the connection before setting its password');
    await this.vault.set(name, password);
  }

  async clearPassword(name: string): Promise<void> {
    this.checkName(name);
    await this.vault.delete(name);
  }

  /** Lists the tables through the same broker the models use, so a pass here means the models can connect too. */
  async test(name: string): Promise<ConnectionTest> {
    const profile = (await this.profiles()).find((p) => p.name === name);
    if (!profile) return { ok: false, error: 'Unknown connection' };
    const broker = new Broker({ profiles: [profile], secrets: this.vault, timeoutMs: 10_000 });
    try {
      return { ok: true, tables: (await broker.listSchema(name)).length };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : 'Connection failed' };
    } finally {
      await broker.close();
    }
  }
}
