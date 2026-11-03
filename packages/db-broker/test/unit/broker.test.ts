import { describe, expect, it, vi } from 'vitest';
import { Broker, BrokerError } from '../../src/broker.js';
import { EnvSecretStore } from '../../src/config.js';
import { normalizeValue, sanitizeError } from '../../src/sanitize.js';
import type { ConnectionProfile, Driver } from '../../src/types.js';

const PASSWORD = 'S3cr3t-pa55word';
const profile: ConnectionProfile = {
  name: 'main',
  engine: 'postgres',
  host: 'db.internal.example',
  port: 5432,
  database: 'crm_prod',
  user: 'readonly_svc',
};

function setup(overrides: Partial<Driver> = {}) {
  const driver: Driver = {
    listTables: vi.fn(async () => [{ schema: 'public', name: 'customers', type: 'BASE TABLE' }]),
    describeTable: vi.fn(async () => [{ name: 'id', type: 'integer', nullable: false }]),
    query: vi.fn(async () => ({ columns: ['id'], rows: [[1], [2]], truncated: false })),
    close: vi.fn(async () => {}),
    ...overrides,
  };
  const audit = { record: vi.fn(async () => {}) };
  const driverFactory = vi.fn(() => driver);
  const broker = new Broker({
    profiles: [profile],
    secrets: new EnvSecretStore({ AIO_SECRET_MAIN: PASSWORD }),
    driverFactory,
    audit,
  });
  return { broker, driver, audit, driverFactory };
}

describe('Broker', () => {
  it('lists connections without host, user or database', () => {
    const { broker } = setup();
    expect(broker.listConnections()).toEqual([{ name: 'main', engine: 'postgres' }]);
    const text = JSON.stringify(broker.listConnections());
    for (const secret of [profile.host, profile.user, profile.database, PASSWORD]) expect(text).not.toContain(secret);
  });

  it('runs a valid select and returns rows', async () => {
    const { broker, driver } = setup();
    const res = await broker.runSelect('main', 'SELECT id FROM customers');
    expect(res).toEqual({ columns: ['id'], rows: [[1], [2]], rowCount: 2, truncated: false });
    expect(driver.query).toHaveBeenCalledOnce();
  });

  it.each(['DROP TABLE customers', 'SELECT 1; DELETE FROM customers', 'SELECT * FROM t FOR UPDATE'])(
    'never reaches the database for %s',
    async (sql) => {
      const { broker, driver, audit } = setup();
      await expect(broker.runSelect('main', sql)).rejects.toBeInstanceOf(BrokerError);
      expect(driver.query).not.toHaveBeenCalled();
      expect(audit.record).toHaveBeenCalledWith(expect.objectContaining({ ok: false, sql }));
    },
  );

  it('rejects unknown connections and lists the valid names', async () => {
    const { broker } = setup();
    await expect(broker.runSelect('nope', 'SELECT 1')).rejects.toThrow(/Unknown connection "nope". Available: main/);
  });

  it('refuses to start without credentials', async () => {
    const broker = new Broker({ profiles: [profile], secrets: new EnvSecretStore({}), driverFactory: vi.fn() });
    await expect(broker.runSelect('main', 'SELECT 1')).rejects.toThrow(/No credentials/);
  });

  it('scrubs password, host, user and database from driver errors', async () => {
    const leaky = new Error(
      `password authentication failed for user "${profile.user}" at ${profile.host}:5432 db=${profile.database} pw=${PASSWORD} url=postgres://${profile.user}:${PASSWORD}@${profile.host}/x`,
    );
    const { broker } = setup({ query: vi.fn(async () => Promise.reject(leaky)) });
    const err = await broker.runSelect('main', 'SELECT 1').catch((e: Error) => e);
    expect(err).toBeInstanceOf(BrokerError);
    for (const secret of [PASSWORD, profile.host, profile.user, profile.database, 'postgres://']) {
      expect((err as Error).message).not.toContain(secret);
    }
  });

  it('never writes secrets to the audit log', async () => {
    const leaky = new Error(`bad login ${PASSWORD} ${profile.host}`);
    const { broker, audit } = setup({ query: vi.fn(async () => Promise.reject(leaky)) });
    await broker.runSelect('main', 'SELECT 1').catch(() => {});
    expect(JSON.stringify((audit.record as ReturnType<typeof vi.fn>).mock.calls)).not.toContain(PASSWORD);
  });

  it('caps the requested row limit at the broker ceiling', async () => {
    const { broker, driver } = setup();
    await broker.runSelect('main', 'SELECT 1', 1_000_000);
    expect(driver.query).toHaveBeenCalledWith('SELECT 1', expect.objectContaining({ maxRows: 200 }));
  });

  it('truncates oversized cells and makes values JSON-safe', async () => {
    const { broker } = setup({
      query: vi.fn(async () => ({
        columns: ['a', 'b', 'c', 'd'],
        rows: [['x'.repeat(5000), 10n, new Date('2024-01-02T03:04:05Z'), Buffer.from('abc')]],
        truncated: true,
      })),
    });
    const res = await broker.runSelect('main', 'SELECT 1');
    const [row] = res.rows;
    expect(String(row![0]).length).toBeLessThan(2100);
    expect(row!.slice(1)).toEqual(['10', '2024-01-02T03:04:05.000Z', '<binary 3 bytes>']);
    expect(res.truncated).toBe(true);
    expect(() => JSON.stringify(res)).not.toThrow();
  });

  it('reuses one driver per connection and closes them', async () => {
    const { broker, driver, driverFactory } = setup();
    await broker.runSelect('main', 'SELECT 1');
    await broker.listSchema('main');
    expect(driverFactory).toHaveBeenCalledTimes(1);
    await broker.close();
    expect(driver.close).toHaveBeenCalledOnce();
  });
});

describe('sanitizeError', () => {
  it('ignores very short sensitive values to avoid mangling messages', () => {
    expect(sanitizeError(new Error('ab is here'), ['ab'])).toBe('ab is here');
  });
  it('truncates long messages', () => {
    expect(sanitizeError(new Error('x'.repeat(2000)), []).length).toBeLessThanOrEqual(501);
  });
});

describe('normalizeValue', () => {
  it('maps undefined and invalid dates to null', () => {
    expect(normalizeValue(undefined, 10)).toBeNull();
    expect(normalizeValue(new Date('nope'), 10)).toBeNull();
  });
});
