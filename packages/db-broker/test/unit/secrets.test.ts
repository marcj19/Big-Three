import { describe, expect, it } from 'vitest';
import { EnvSecretStore } from '../../src/config.js';
import { runSecretCli } from '../../src/secret-cli.js';
import { ChainedSecretStore, KEYRING_SERVICE, KeyringSecretStore, type EntryFactory } from '../../src/secrets.js';
import type { SecretStore } from '../../src/types.js';

/** An in-memory vault keyed the way the real one is: (service, account). */
function memoryVault() {
  const data = new Map<string, string>();
  const factory: EntryFactory = (service, account) => {
    const key = `${service}\u0000${account}`;
    return {
      getPassword: () => data.get(key) ?? null,
      setPassword: (p) => void data.set(key, p),
      deletePassword: () => data.delete(key),
    };
  };
  return { data, factory };
}

describe('KeyringSecretStore', () => {
  it('stores, reads, reports and removes a password per connection', async () => {
    const vault = memoryVault();
    const store = new KeyringSecretStore({ entryFactory: vault.factory });
    expect(await store.get('crm')).toBeUndefined();
    expect(await store.has('crm')).toBe(false);

    await store.set('crm', 's3cret');
    await store.set('other', 'different');
    expect(await store.get('crm')).toBe('s3cret');
    expect(await store.get('other')).toBe('different');
    expect(await store.has('crm')).toBe(true);

    expect(await store.delete('crm')).toBe(true);
    expect(await store.delete('crm')).toBe(false);
    expect(await store.get('crm')).toBeUndefined();
    expect(await store.get('other')).toBe('different');
  });

  it('keeps entries under the app service with a db: account prefix, so it cannot touch unrelated credentials', async () => {
    const vault = memoryVault();
    await new KeyringSecretStore({ entryFactory: vault.factory }).set('crm', 'pw');
    expect([...vault.data.keys()]).toEqual([`${KEYRING_SERVICE}\u0000db:crm`]);
  });

  it('refuses an empty password', async () => {
    const store = new KeyringSecretStore({ entryFactory: memoryVault().factory });
    await expect(store.set('crm', '')).rejects.toThrow(/empty/);
  });
});

describe('ChainedSecretStore', () => {
  const store = (value: string | undefined | Error): SecretStore => ({
    get: async () => {
      if (value instanceof Error) throw value;
      return value;
    },
  });

  it('uses the first store that has the password', async () => {
    expect(await new ChainedSecretStore([store('vault'), store('env')]).get('x')).toBe('vault');
    expect(await new ChainedSecretStore([store(undefined), store('env')]).get('x')).toBe('env');
  });

  it('returns undefined when nobody has it', async () => {
    expect(await new ChainedSecretStore([store(undefined), store(undefined)]).get('x')).toBeUndefined();
  });

  it('falls through a broken vault to the next store', async () => {
    expect(await new ChainedSecretStore([store(new Error('no keyring')), store('env')]).get('x')).toBe('env');
  });

  it('reports a broken vault when nothing else has the password, without repeating the vault\'s own message', async () => {
    const chain = new ChainedSecretStore([store(new Error('C:\\Users\\me\\vault locked, account db:crm')), new EnvSecretStore({})]);
    const err = await chain.get('crm').catch((e: Error) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toBe('Could not read credentials from the system vault');
  });
});

describe('aio-db-secret', () => {
  function setup(typed = 'typed-secret') {
    const vault = memoryVault();
    const lines: string[] = [];
    const prompts: string[] = [];
    const io = {
      store: new KeyringSecretStore({ entryFactory: vault.factory }),
      readSecret: async (p: string) => (prompts.push(p), typed),
      out: (l: string) => void lines.push(l),
    };
    return { vault, lines, prompts, io };
  }

  it('set stores what was typed and never prints it', async () => {
    const { io, lines, vault } = setup('typed-secret');
    expect(await runSecretCli(['set', 'crm'], io)).toBe(0);
    expect([...vault.data.values()]).toEqual(['typed-secret']);
    expect(lines.join('\n')).not.toContain('typed-secret');
  });

  it('status says whether a password exists and never reveals it', async () => {
    const { io, lines } = setup();
    expect(await runSecretCli(['status', 'crm'], io)).toBe(1);
    await runSecretCli(['set', 'crm'], io);
    expect(await runSecretCli(['status', 'crm'], io)).toBe(0);
    expect(lines.join('\n')).not.toContain('typed-secret');
    expect(lines.at(-1)).toContain('a password is stored');
  });

  it('delete removes it', async () => {
    const { io, vault } = setup();
    await runSecretCli(['set', 'crm'], io);
    expect(await runSecretCli(['delete', 'crm'], io)).toBe(0);
    expect(vault.data.size).toBe(0);
  });

  it('does not store an empty password', async () => {
    const { io, vault } = setup('');
    expect(await runSecretCli(['set', 'crm'], io)).toBe(1);
    expect(vault.data.size).toBe(0);
  });

  it('rejects a password given on the command line, odd names and unknown commands', async () => {
    const { io, vault, prompts } = setup();
    expect(await runSecretCli(['set', 'crm', 'oops-password'], io)).toBe(2);
    expect(await runSecretCli(['set', '../../etc'], io)).toBe(2);
    expect(await runSecretCli(['set', 'a b'], io)).toBe(2);
    expect(await runSecretCli(['frobnicate', 'crm'], io)).toBe(2);
    expect(await runSecretCli([], io)).toBe(2);
    expect(vault.data.size).toBe(0);
    expect(prompts).toEqual([]);
  });
});
