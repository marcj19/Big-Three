import pg from 'pg';
import Cursor from 'pg-cursor';
import type { ColumnInfo, Driver, QueryOptions, QueryResult, TableInfo } from '../types.js';
import type { DriverConfig } from './index.js';

const SYSTEM_SCHEMAS = "('pg_catalog', 'information_schema')";

export class PostgresDriver implements Driver {
  private readonly pool: pg.Pool;

  constructor({ profile, password }: DriverConfig) {
    this.pool = new pg.Pool({
      host: profile.host,
      port: profile.port,
      database: profile.database,
      user: profile.user,
      password,
      ssl: profile.ssl ? { rejectUnauthorized: true } : undefined,
      max: 4,
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 10_000,
      // Belt and braces: every session defaults to read-only even outside our own BEGIN READ ONLY.
      options: '-c default_transaction_read_only=on',
    });
    // Without a listener an idle-client error would crash the process.
    this.pool.on('error', () => {});
  }

  async listTables(): Promise<TableInfo[]> {
    const res = await this.pool.query(
      `SELECT table_schema, table_name, table_type FROM information_schema.tables
       WHERE table_schema NOT IN ${SYSTEM_SCHEMAS} ORDER BY 1, 2`,
    );
    return res.rows.map((r) => ({ schema: r.table_schema, name: r.table_name, type: r.table_type }));
  }

  async describeTable(table: string, schema?: string): Promise<ColumnInfo[]> {
    const params: string[] = [table];
    let schemaFilter = '';
    if (schema) {
      params.push(schema);
      schemaFilter = 'AND table_schema = $2';
    }
    const res = await this.pool.query(
      `SELECT column_name, data_type, is_nullable FROM information_schema.columns
       WHERE table_name = $1 ${schemaFilter} AND table_schema NOT IN ${SYSTEM_SCHEMAS}
       ORDER BY ordinal_position`,
      params,
    );
    return res.rows.map((r) => ({ name: r.column_name, type: r.data_type, nullable: r.is_nullable === 'YES' }));
  }

  async query(sql: string, { maxRows, timeoutMs }: QueryOptions): Promise<QueryResult> {
    const client = await this.pool.connect();
    let failure: Error | undefined;
    try {
      await client.query('BEGIN READ ONLY');
      await client.query(`SET LOCAL statement_timeout = ${Math.trunc(timeoutMs)}`);
      const cursor = client.query(new Cursor(sql, [], { rowMode: 'array' }));
      const { rows, fields } = await new Promise<{ rows: unknown[][]; fields: pg.FieldDef[] }>((resolve, reject) => {
        cursor.read(maxRows + 1, (err, rows, result) => {
          if (err) reject(err);
          else resolve({ rows: rows as unknown[][], fields: result?.fields ?? [] });
        });
      });
      await new Promise<void>((resolve) => cursor.close(() => resolve()));
      return {
        columns: fields.map((f) => f.name),
        rows: rows.slice(0, maxRows),
        truncated: rows.length > maxRows,
      };
    } catch (err) {
      failure = err as Error;
      throw err;
    } finally {
      if (!failure) await client.query('ROLLBACK').catch((e) => (failure = e));
      // Passing an error destroys the connection instead of returning it to the pool in a bad state.
      client.release(failure);
    }
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}
