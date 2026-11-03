import { noAudit, type AuditLog } from './audit.js';
import { createDriver, type DriverFactory } from './drivers/index.js';
import { normalizeValue, sanitizeError } from './sanitize.js';
import { assertReadOnlySelect, SqlGuardError } from './sql-guard.js';
import type { ColumnInfo, ConnectionProfile, Driver, SecretStore, TableInfo } from './types.js';

export interface BrokerOptions {
  profiles: ConnectionProfile[];
  secrets: SecretStore;
  driverFactory?: DriverFactory;
  audit?: AuditLog;
  /** Hard ceiling for rows returned by one query. */
  maxRows?: number;
  timeoutMs?: number;
  maxCellChars?: number;
}

export interface SelectResult {
  columns: string[];
  rows: unknown[][];
  rowCount: number;
  truncated: boolean;
}

/** Error whose message is safe to show to a model. */
export class BrokerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BrokerError';
  }
}

export class Broker {
  private readonly profiles = new Map<string, ConnectionProfile>();
  private readonly drivers = new Map<string, Driver>();
  private readonly driverFactory: DriverFactory;
  private readonly audit: AuditLog;
  private readonly maxRows: number;
  private readonly timeoutMs: number;
  private readonly maxCellChars: number;

  constructor(private readonly opts: BrokerOptions) {
    for (const p of opts.profiles) this.profiles.set(p.name, p);
    this.driverFactory = opts.driverFactory ?? createDriver;
    this.audit = opts.audit ?? noAudit;
    this.maxRows = opts.maxRows ?? 200;
    this.timeoutMs = opts.timeoutMs ?? 15_000;
    this.maxCellChars = opts.maxCellChars ?? 2_000;
  }

  /** Only names and engines are exposed: no host, user or database. */
  listConnections(): { name: string; engine: string }[] {
    return [...this.profiles.values()].map((p) => ({ name: p.name, engine: p.engine }));
  }

  listSchema(connection: string): Promise<TableInfo[]> {
    return this.run(connection, 'list_schema', undefined, (d) => d.listTables());
  }

  describeTable(connection: string, table: string, schema?: string): Promise<ColumnInfo[]> {
    return this.run(connection, 'describe_table', `${schema ? schema + '.' : ''}${table}`, (d) => d.describeTable(table, schema));
  }

  async runSelect(connection: string, sql: string, requestedMaxRows?: number): Promise<SelectResult> {
    const profile = this.profile(connection);
    const maxRows = Math.min(Math.max(1, Math.trunc(requestedMaxRows ?? this.maxRows)), this.maxRows);
    return this.run(connection, 'run_select', sql, async (driver) => {
      assertReadOnlySelect(sql, profile.engine, { allowedFunctions: profile.allowedFunctions });
      const res = await driver.query(sql, { maxRows, timeoutMs: this.timeoutMs });
      const rows = res.rows.map((r) => r.map((v) => normalizeValue(v, this.maxCellChars)));
      return { columns: res.columns, rows, rowCount: rows.length, truncated: res.truncated };
    });
  }

  async close(): Promise<void> {
    await Promise.allSettled([...this.drivers.values()].map((d) => d.close()));
    this.drivers.clear();
  }

  private profile(name: string): ConnectionProfile {
    const profile = this.profiles.get(name);
    if (!profile) {
      const known = [...this.profiles.keys()].join(', ') || '(none configured)';
      throw new BrokerError(`Unknown connection "${name}". Available: ${known}`);
    }
    return profile;
  }

  private async driver(profile: ConnectionProfile): Promise<{ driver: Driver; password: string }> {
    const password = await this.opts.secrets.get(profile.name);
    if (password === undefined) {
      throw new BrokerError(`No credentials are configured for connection "${profile.name}"`);
    }
    let driver = this.drivers.get(profile.name);
    if (!driver) {
      driver = this.driverFactory({ profile, password });
      this.drivers.set(profile.name, driver);
    }
    return { driver, password };
  }

  /** Common path: resolve driver, audit, and turn any failure into a message that cannot leak secrets. */
  private async run<T>(connection: string, tool: string, sql: string | undefined, fn: (d: Driver) => Promise<T>): Promise<T> {
    const profile = this.profile(connection);
    let password = '';
    try {
      const resolved = await this.driver(profile);
      password = resolved.password;
      const result = await fn(resolved.driver);
      const rowCount = Array.isArray(result) ? result.length : (result as Partial<SelectResult>).rowCount;
      await this.audit.record({ connection, tool, sql, ok: true, rowCount });
      return result;
    } catch (err) {
      const safe =
        err instanceof BrokerError || err instanceof SqlGuardError
          ? err.message
          : sanitizeError(err, [password, profile.host, profile.user, profile.database]);
      await this.audit.record({ connection, tool, sql, ok: false, error: safe });
      throw new BrokerError(safe);
    }
  }
}
