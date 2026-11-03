import { CONNECTION_NAME } from './config.js';
import type { WritableSecretStore } from './secrets.js';

export interface SecretCliIo {
  store: WritableSecretStore;
  /** Returns the password typed (hidden) or piped in. Never called with the password on the command line. */
  readSecret(prompt: string): Promise<string>;
  out(line: string): void;
}

const USAGE = 'Usage: aio-db-secret set <connection> | status <connection> | delete <connection>';

/**
 * Manages the password of a connection in the system vault. The password is never an argument (it would land in
 * shell history and in the process list) and is never printed back: `status` only says whether one is stored.
 * Returns the process exit code.
 */
export async function runSecretCli(argv: string[], io: SecretCliIo): Promise<number> {
  const [command, name, ...extra] = argv;
  if (!command || !name || extra.length > 0) {
    io.out(USAGE);
    return 2;
  }
  if (!CONNECTION_NAME.test(name)) {
    io.out('Connection names are 1-64 characters of letters, digits, _ or -.');
    return 2;
  }
  switch (command) {
    case 'set': {
      const password = await io.readSecret(`Password for "${name}": `);
      if (!password) {
        io.out('No password entered; nothing stored.');
        return 1;
      }
      await io.store.set(name, password);
      io.out(`Stored the password for "${name}" in the system vault.`);
      return 0;
    }
    case 'status': {
      const has = await io.store.has(name);
      io.out(has ? `"${name}": a password is stored.` : `"${name}": no password stored.`);
      return has ? 0 : 1;
    }
    case 'delete': {
      const removed = await io.store.delete(name);
      io.out(removed ? `Removed the password for "${name}".` : `"${name}": nothing to remove.`);
      return 0;
    }
    default:
      io.out(USAGE);
      return 2;
  }
}
