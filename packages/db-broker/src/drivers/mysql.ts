import type mysqlCore from 'mysql2';
import mysql from 'mysql2/promise';
import type { ColumnInfo, Driver, QueryOptions, QueryResult, TableInfo } from '../types.js';
import type { DriverConfig } from './index.js';

export class MysqlDriver implements Driver {
  private readonly pool: mysql.Pool;

  constructor({ profile, password }: DriverConfig) {
    this.pool = mysql.createPool({
      host: profile.host,
      port: profile.port,
      database: profile.database,
      user: profile.user,
      password,
      ssl: profile.ssl ? { rejectUnauthorized: true } : undefined,
      connectionLimit: 4,
      connectTimeout: 10_000,
      multipleStatements: false,
      // Never let the driver apply client-side value substitution to our statements.
      namedPlaceholders: false,
    });
  }

  async listTables(): Promise<TableInfo[]> {
    const [rows] = await this.pool.query<mysql.RowDataPacket[]>(
      `SELECT table_schema AS s, table_name AS n, table_type AS t FROM information_schema.tables
       WHERE table_schema = DATABASE() ORDER BY 1, 2`,
    );
    return rows.map((r) => ({ schema: r.s, name: r.n, type: r.t }));
  }

  async describeTable(table: string): Promise<ColumnInfo[]> {
    const [rows] = await this.pool.query<mysql.RowDataPacket[]>(
      `SELECT column_name AS n, column_type AS t, is_nullable AS nl FROM information_schema.columns
       WHERE table_schema = DATABASE() AND table_name = ? ORDER BY ordinal_position`,
      [table],
    );
    return rows.map((r) => ({ name: r.n, type: r.t, nullable: r.nl === 'YES' }));
  }

  async query(sql: string, { maxRows, timeoutMs }: QueryOptions): Promise<QueryResult> {
    const conn = await this.pool.getConnection();
    let discard = false;
    try {
      // The guard tokenizes with backslash escapes on, so make the server agree.
      await conn.query("SET SESSION sql_mode = REPLACE(@@SESSION.sql_mode, 'NO_BACKSLASH_ESCAPES', '')");
      await conn.query('SET SESSION TRANSACTION READ ONLY');
      await conn.query(`SET SESSION MAX_EXECUTION_TIME = ${Math.trunc(timeoutMs)}`);
      await conn.query('START TRANSACTION READ ONLY');

      // `conn.connection` is the callback-style connection at runtime, which is what exposes .stream().
      const core = conn.connection as unknown as mysqlCore.Connection;
      const stream = core.query({ sql, rowsAsArray: true }).stream();
      const rows: unknown[][] = [];
      let columns: string[] = [];
      let truncated = false;
      await new Promise<void>((resolve, reject) => {
        stream.on('fields', (fields: { name: string }[]) => {
          columns = fields.map((f) => f.name);
        });
        stream.on('data', (row: unknown[]) => {
          if (rows.length < maxRows) {
            rows.push(row);
          } else {
            truncated = true;
            stream.destroy();
          }
        });
        stream.on('error', reject);
        stream.on('close', resolve);
        stream.on('end', resolve);
      });
      // Stopping a stream early leaves the server still sending rows: drop this connection.
      if (truncated) discard = true;
      else await conn.query('ROLLBACK');
      return { columns, rows, truncated };
    } catch (err) {
      discard = true;
      throw err;
    } finally {
      if (discard) conn.destroy();
      else conn.release();
    }
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}
