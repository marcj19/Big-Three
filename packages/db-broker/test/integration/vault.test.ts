/**
 * The broker as a model CLI would start it: a separate process whose environment carries NO password, reading it
 * from the real system vault (Windows Credential Manager on this machine).
 *
 *   docker compose -f test/integration/compose.yml up -d --wait postgres
 *   AIO_INTEGRATION=1 npx vitest run test/integration/vault.test.ts
 *
 * Writes one throwaway credential, "ai-orchestrator / db:aio-vault-test", and removes it afterwards.
 */
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { KeyringSecretStore } from '../../src/secrets.js';

const enabled = process.env.AIO_INTEGRATION === '1';
const NAME = 'aio-vault-test';
const RO_PW = 'ro_pw_test';
const server = fileURLToPath(new URL('../../src/server.ts', import.meta.url));

describe.runIf(enabled)('broker started with a scrubbed environment', () => {
  const store = new KeyringSecretStore();
  let configDir: string;
  let client: Client;

  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const r = (await client.callTool({ name, arguments: args })) as { isError?: boolean; content: { text: string }[] };
    return { isError: r.isError === true, text: r.content.map((c) => c.text).join('\n') };
  };

  beforeAll(async () => {
    const admin = new pg.Client({ host: '127.0.0.1', port: 55432, database: 'aio_test', user: 'postgres', password: 'admin_pw_test' });
    await admin.connect();
    try {
      await admin.query('DROP TABLE IF EXISTS public.aio_items');
      await admin.query('CREATE TABLE public.aio_items (id int PRIMARY KEY, label varchar(50))');
      await admin.query("INSERT INTO public.aio_items SELECT g, 'item ' || g FROM generate_series(1, 300) g");
      await admin.query('DROP ROLE IF EXISTS aio_ro');
      await admin.query(`CREATE ROLE aio_ro LOGIN PASSWORD '${RO_PW}'`);
      await admin.query('GRANT CONNECT ON DATABASE aio_test TO aio_ro');
      await admin.query('GRANT USAGE ON SCHEMA public TO aio_ro');
      await admin.query('GRANT SELECT ON public.aio_items TO aio_ro');
    } finally {
      await admin.end();
    }

    configDir = await mkdtemp(path.join(os.tmpdir(), 'aio-vault-test-'));
    await writeFile(
      path.join(configDir, 'connections.json'),
      JSON.stringify([{ name: NAME, engine: 'postgres', host: '127.0.0.1', port: 55432, database: 'aio_test', user: 'aio_ro' }]),
    );
    await store.set(NAME, RO_PW);

    // The password must exist only in the vault: neither this process nor the child gets it through the environment.
    expect(Object.keys(process.env).filter((k) => k.startsWith('AIO_SECRET_'))).toEqual([]);
    client = new Client({ name: 'vault-test', version: '0' });
    await client.connect(
      new StdioClientTransport({
        command: process.execPath,
        args: ['--import', import.meta.resolve('tsx'), server],
        env: { AIO_CONFIG_DIR: configDir },
        stderr: 'pipe',
      }),
    );
  }, 60_000);

  afterAll(async () => {
    await client?.close();
    await store.delete(NAME);
    if (configDir) await rm(configDir, { recursive: true, force: true });
  });

  it('queries the database with a password it read from the vault itself', async () => {
    const r = await call('run_select', { connection: NAME, sql: 'SELECT count(*) AS n FROM public.aio_items' });
    expect(r.isError).toBe(false);
    expect(r.text).toContain('300');
  });

  it('still refuses writes', async () => {
    const r = await call('run_select', { connection: NAME, sql: "UPDATE public.aio_items SET label = 'x'" });
    expect(r.isError).toBe(true);
  });

  it('never shows the password to the model', async () => {
    const all = [await call('list_connections'), await call('list_schema', { connection: NAME })];
    expect(all.map((r) => r.text).join('\n')).not.toContain(RO_PW);
  });

  it('reports missing credentials once the vault entry is removed', async () => {
    await store.delete(NAME);
    // A fresh process: the running one already holds an open pool authenticated earlier.
    const c2 = new Client({ name: 'vault-test-2', version: '0' });
    await c2.connect(
      new StdioClientTransport({ command: process.execPath, args: ['--import', import.meta.resolve('tsx'), server], env: { AIO_CONFIG_DIR: configDir }, stderr: 'pipe' }),
    );
    try {
      const r = (await c2.callTool({ name: 'run_select', arguments: { connection: NAME, sql: 'SELECT 1' } })) as { isError?: boolean; content: { text: string }[] };
      expect(r.isError).toBe(true);
      expect(r.content[0]!.text).toMatch(/No credentials/);
    } finally {
      await c2.close();
    }
  }, 30_000);
});
