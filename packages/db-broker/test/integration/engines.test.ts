/**
 * Runs against the throwaway databases in compose.yml:
 *   docker compose -f test/integration/compose.yml up -d --wait
 *   AIO_INTEGRATION=1 npx vitest run test/integration
 * Enable a subset with AIO_INTEGRATION_ENGINES=postgres,mysql
 */
import mysql from 'mysql2/promise';
import oracledb from 'oracledb';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Broker, BrokerError } from '../../src/broker.js';
import { EnvSecretStore } from '../../src/config.js';
import { createDriver } from '../../src/drivers/index.js';
import type { ConnectionProfile, Engine } from '../../src/types.js';

const ADMIN_PW = 'admin_pw_test';
const RO_PW = 'ro_pw_test';
const enabled = (process.env.AIO_INTEGRATION_ENGINES ?? 'postgres,mysql,oracle').split(',') as Engine[];

interface EngineSpec {
  engine: Engine;
  /** Fully qualified table name as the read-only user must write it. */
  table: string;
  adminProfile: ConnectionProfile;
  roProfile: ConnectionProfile;
  /** Prepares schema, seed data and the read-only user using an admin connection. */
  setup(): Promise<void>;
  countRows(): Promise<number>;
  slowQuery: string;
  /** Names of one table column, lowercase. */
  describeName: string;
}

const base = { host: '127.0.0.1' };

const specs: EngineSpec[] = [
  {
    engine: 'postgres',
    table: 'public.aio_items',
    describeName: 'aio_items',
    slowQuery: 'SELECT pg_sleep(10)',
    adminProfile: { ...base, name: 'admin', engine: 'postgres', port: 55432, database: 'aio_test', user: 'postgres' },
    roProfile: { ...base, name: 'ro', engine: 'postgres', port: 55432, database: 'aio_test', user: 'aio_ro' },
    async setup() {
      const c = new pg.Client({ ...this.adminProfile, password: ADMIN_PW });
      await c.connect();
      try {
        await c.query('DROP TABLE IF EXISTS public.aio_items');
        await c.query('CREATE TABLE public.aio_items (id int PRIMARY KEY, label varchar(50))');
        await c.query("INSERT INTO public.aio_items SELECT g, 'item ' || g FROM generate_series(1, 300) g");
        await c.query('DROP ROLE IF EXISTS aio_ro');
        await c.query(`CREATE ROLE aio_ro LOGIN PASSWORD '${RO_PW}'`);
        await c.query('GRANT CONNECT ON DATABASE aio_test TO aio_ro');
        await c.query('GRANT USAGE ON SCHEMA public TO aio_ro');
        await c.query('GRANT SELECT ON public.aio_items TO aio_ro');
      } finally {
        await c.end();
      }
    },
    async countRows() {
      const c = new pg.Client({ ...this.adminProfile, password: ADMIN_PW });
      await c.connect();
      try {
        return Number((await c.query('SELECT count(*) AS n FROM public.aio_items')).rows[0].n);
      } finally {
        await c.end();
      }
    },
  },
  {
    engine: 'mysql',
    table: 'aio_items',
    describeName: 'aio_items',
    slowQuery: 'SELECT SLEEP(10)',
    adminProfile: { ...base, name: 'admin', engine: 'mysql', port: 53306, database: 'aio_test', user: 'root' },
    roProfile: { ...base, name: 'ro', engine: 'mysql', port: 53306, database: 'aio_test', user: 'aio_ro' },
    async setup() {
      const c = await mysql.createConnection({ ...this.adminProfile, password: ADMIN_PW });
      try {
        await c.query('DROP TABLE IF EXISTS aio_items');
        await c.query('CREATE TABLE aio_items (id int PRIMARY KEY, label varchar(50))');
        await c.query(
          "INSERT INTO aio_items WITH RECURSIVE s(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM s WHERE n < 300) SELECT n, CONCAT('item ', n) FROM s",
        );
        await c.query('DROP USER IF EXISTS aio_ro');
        await c.query(`CREATE USER 'aio_ro'@'%' IDENTIFIED BY '${RO_PW}'`);
        await c.query("GRANT SELECT ON aio_test.aio_items TO 'aio_ro'@'%'");
      } finally {
        await c.end();
      }
    },
    async countRows() {
      const c = await mysql.createConnection({ ...this.adminProfile, password: ADMIN_PW });
      try {
        const [rows] = await c.query<mysql.RowDataPacket[]>('SELECT COUNT(*) AS n FROM aio_items');
        return Number(rows[0]!.n);
      } finally {
        await c.end();
      }
    },
  },
  {
    engine: 'oracle',
    table: 'aio_owner.aio_items',
    describeName: 'aio_items',
    slowQuery: 'SELECT COUNT(*) FROM all_objects a, all_objects b, all_objects c',
    adminProfile: { ...base, name: 'admin', engine: 'oracle', port: 51521, database: 'FREEPDB1', user: 'system' },
    roProfile: { ...base, name: 'ro', engine: 'oracle', port: 51521, database: 'FREEPDB1', user: 'aio_ro' },
    async setup() {
      const c = await oracledb.getConnection({
        user: 'system',
        password: ADMIN_PW,
        connectString: '127.0.0.1:51521/FREEPDB1',
      });
      const ignore = (p: Promise<unknown>) => p.catch(() => {});
      try {
        await ignore(c.execute('DROP USER aio_ro CASCADE'));
        await ignore(c.execute('DROP USER aio_owner CASCADE'));
        await c.execute(`CREATE USER aio_owner IDENTIFIED BY "${ADMIN_PW}" QUOTA UNLIMITED ON USERS`);
        await c.execute('GRANT CREATE SESSION, CREATE TABLE TO aio_owner');
        await c.execute('CREATE TABLE aio_owner.aio_items (id NUMBER(10) PRIMARY KEY, label VARCHAR2(50))');
        await c.execute("INSERT INTO aio_owner.aio_items SELECT LEVEL, 'item ' || LEVEL FROM dual CONNECT BY LEVEL <= 300");
        await c.commit();
        await c.execute(`CREATE USER aio_ro IDENTIFIED BY "${RO_PW}"`);
        await c.execute('GRANT CREATE SESSION TO aio_ro');
        await c.execute('GRANT SELECT ON aio_owner.aio_items TO aio_ro');
      } finally {
        await c.close();
      }
    },
    async countRows() {
      const c = await oracledb.getConnection({
        user: 'system',
        password: ADMIN_PW,
        connectString: '127.0.0.1:51521/FREEPDB1',
      });
      try {
        const res = await c.execute<[number]>('SELECT COUNT(*) FROM aio_owner.aio_items', [], {
          outFormat: oracledb.OUT_FORMAT_ARRAY,
        });
        return Number(res.rows![0]![0]);
      } finally {
        await c.close();
      }
    },
  },
];

describe.skipIf(!process.env.AIO_INTEGRATION).each(specs.filter((s) => enabled.includes(s.engine)))(
  'integration: $engine',
  (spec) => {
    const secrets = new EnvSecretStore({ AIO_SECRET_RO: RO_PW, AIO_SECRET_ADMIN: ADMIN_PW, AIO_SECRET_BADPW: 'wrong-password-123' });
    const broker = new Broker({ profiles: [spec.roProfile], secrets, timeoutMs: 1_500 });

    beforeAll(() => spec.setup(), 240_000);
    afterAll(() => broker.close());

    it('lists the table in the schema', async () => {
      const tables = await broker.listSchema('ro');
      expect(tables.map((t) => t.name.toLowerCase())).toContain('aio_items');
    });

    it('describes columns', async () => {
      const cols = await broker.describeTable('ro', spec.describeName);
      expect(cols.map((c) => c.name.toLowerCase())).toEqual(['id', 'label']);
    });

    it('selects rows', async () => {
      const res = await broker.runSelect('ro', `SELECT id, label FROM ${spec.table} WHERE id <= 3 ORDER BY id`);
      expect(res.rowCount).toBe(3);
      expect(res.rows.map((r) => Number(r[0]))).toEqual([1, 2, 3]);
      expect(res.truncated).toBe(false);
    });

    it('truncates at the requested row limit', async () => {
      const res = await broker.runSelect('ro', `SELECT id FROM ${spec.table} ORDER BY id`, 10);
      expect(res.rowCount).toBe(10);
      expect(res.truncated).toBe(true);
    });

    it('keeps working after a truncated query (connection is not left dirty)', async () => {
      for (let i = 0; i < 6; i++) {
        const res = await broker.runSelect('ro', `SELECT id FROM ${spec.table} ORDER BY id`, 5);
        expect(res.rowCount).toBe(5);
      }
    });

    it.each([
      `DELETE FROM ${'${T}'}`,
      `DROP TABLE ${'${T}'}`,
      `SELECT 1 FROM ${'${T}'}; DELETE FROM ${'${T}'}`,
      `SELECT * FROM ${'${T}'} FOR UPDATE`,
    ])('blocks %s before it reaches the database', async (template) => {
      const before = await spec.countRows();
      await expect(broker.runSelect('ro', template.replaceAll('${T}', spec.table))).rejects.toBeInstanceOf(BrokerError);
      expect(await spec.countRows()).toBe(before);
    });

    it('read-only transaction rejects writes even if the guard were bypassed (admin account, raw driver)', async () => {
      const driver = createDriver({ profile: spec.adminProfile, password: ADMIN_PW });
      try {
        const before = await spec.countRows();
        await expect(driver.query(`DELETE FROM ${spec.table}`, { maxRows: 10, timeoutMs: 2_000 })).rejects.toThrow();
        expect(await spec.countRows()).toBe(before);
        // And the connection must still be usable afterwards.
        const ok = await driver.query(`SELECT COUNT(*) FROM ${spec.table}`, { maxRows: 10, timeoutMs: 2_000 });
        expect(Number(ok.rows[0]![0])).toBe(before);
      } finally {
        await driver.close();
      }
    });

    it('the read-only database account has no write privilege either', async () => {
      const driver = createDriver({ profile: spec.roProfile, password: RO_PW });
      try {
        await expect(driver.query(`DELETE FROM ${spec.table}`, { maxRows: 10, timeoutMs: 2_000 })).rejects.toThrow();
      } finally {
        await driver.close();
      }
    });

    it('enforces the statement timeout', async () => {
      const driver = createDriver({ profile: spec.roProfile, password: RO_PW });
      const started = Date.now();
      try {
        // Not every engine raises an error on timeout (MySQL SLEEP may return early); the point is it stops quickly.
        await driver.query(spec.slowQuery, { maxRows: 10, timeoutMs: 500 }).catch(() => {});
        expect(Date.now() - started).toBeLessThan(5_000);
      } finally {
        await driver.close();
      }
    }, 30_000);

    it('does not leak host, user, database or password when login fails', async () => {
      const bad = new Broker({
        profiles: [{ ...spec.roProfile, name: 'badpw' }],
        secrets,
        timeoutMs: 1_500,
      });
      try {
        const err = await bad.listSchema('badpw').catch((e: Error) => e);
        expect(err).toBeInstanceOf(BrokerError);
        const msg = (err as Error).message;
        for (const secret of ['wrong-password-123', '127.0.0.1', spec.roProfile.user, spec.roProfile.database]) {
          expect(msg).not.toContain(secret);
        }
      } finally {
        await bad.close();
      }
    });
  },
);
