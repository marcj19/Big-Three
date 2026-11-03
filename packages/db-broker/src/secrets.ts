import type { SecretStore } from './types.js';

export const KEYRING_SERVICE = 'ai-orchestrator';

/** What a store the app can write to looks like. The broker itself only ever needs `get`. */
export interface WritableSecretStore extends SecretStore {
  set(connectionName: string, password: string): Promise<void>;
  /** Returns whether something was removed. */
  delete(connectionName: string): Promise<boolean>;
  has(connectionName: string): Promise<boolean>;
}

/** The slice of `@napi-rs/keyring`'s `Entry` that is used; lets tests supply an in-memory vault. */
export interface KeyringEntry {
  getPassword(): string | null;
  setPassword(password: string): void;
  deletePassword(): boolean;
}
export type EntryFactory = (service: string, account: string) => KeyringEntry;

async function nativeEntryFactory(): Promise<EntryFactory> {
  // Loaded on demand: the native module is only needed where a vault is actually used.
  const { Entry } = await import('@napi-rs/keyring');
  return (service, account) => new Entry(service, account);
}

/**
 * Passwords in the operating system's vault (Windows Credential Manager, macOS Keychain, Secret Service). The
 * vault is read by the broker process itself, so nothing secret has to travel through the environment or the
 * config file of a model CLI.
 *
 * Limit worth knowing: the vault is per OS user. A model that can run arbitrary commands as you could read it
 * the same way this class does. The primary defence stays a database user that can only SELECT.
 */
export class KeyringSecretStore implements WritableSecretStore {
  private factory: EntryFactory | undefined;

  constructor(private readonly options: { service?: string; entryFactory?: EntryFactory } = {}) {
    this.factory = options.entryFactory;
  }

  private async entry(connectionName: string): Promise<KeyringEntry> {
    this.factory ??= await nativeEntryFactory();
    return this.factory(this.options.service ?? KEYRING_SERVICE, `db:${connectionName}`);
  }

  async get(connectionName: string): Promise<string | undefined> {
    return (await this.entry(connectionName)).getPassword() ?? undefined;
  }

  async has(connectionName: string): Promise<boolean> {
    return (await this.get(connectionName)) !== undefined;
  }

  async set(connectionName: string, password: string): Promise<void> {
    if (!password) throw new Error('Refusing to store an empty password');
    (await this.entry(connectionName)).setPassword(password);
  }

  async delete(connectionName: string): Promise<boolean> {
    return (await this.entry(connectionName)).deletePassword();
  }
}

/**
 * Tries each store in order and uses the first password found. A store that errors (no vault on this machine, say)
 * does not stop the next one; only if nobody has the password and something errored is the problem reported.
 */
export class ChainedSecretStore implements SecretStore {
  constructor(private readonly stores: SecretStore[]) {}

  async get(connectionName: string): Promise<string | undefined> {
    let failed = false;
    for (const store of this.stores) {
      try {
        const value = await store.get(connectionName);
        if (value !== undefined) return value;
      } catch {
        failed = true; // the vault's own message could carry paths or account names; keep it out of model-visible errors
      }
    }
    if (failed) throw new Error('Could not read credentials from the system vault');
    return undefined;
  }
}
