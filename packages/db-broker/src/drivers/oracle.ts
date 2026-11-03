import oracledb from 'oracledb';
import type { ColumnInfo, Driver, QueryOptions, QueryResult, TableInfo } from '../types.js';
import type { DriverConfig } from './index.js';

oracledb.fetchAsString = [oracledb.CLOB];

const USER_OWNED = `owner NOT IN (SELECT username FROM all_users WHERE oracle_maintained = 'Y')`;

export class OracleDriver implements Driver {
  private poolPromise: Promise<oracledb.Pool> | undefined;

  constructor(private readonly config: DriverConfig) {}

  private getPool(): Promise<oracledb.Pool> {
    const { profile, password } = this.config;
    // Created lazily so a bad Oracle profile does not break the other engines at startup.
    if (!this.poolPromise) {
      this.poolPromise = oracledb.createPool({
        user: profile.user,
        password,
        connectString: `${profile.host}:${profile.port}/${profile.database}`,
        poolMin: 0,
        poolMax: 4,
        poolTimeout: 30,
        queueTimeout: 10_000,
      });
    }
    return this.poolPromise;
  }

  private async withConnection<T>(fn: (conn: oracledb.Connection) => Promise<T>): Promise<T> {
    const conn = await (await this.getPool()).getConnection();
    try {
      return await fn(conn);
    } finally {
      await conn.close().catch(() => {});
    }
  }

  async listTables(): Promise<TableInfo[]> {
    return this.withConnection(async (conn) => {
      const res = await conn.execute<[string, string, string]>(
        `SELECT owner, table_name, 'TABLE' FROM all_tables WHERE ${USER_OWNED}
         UNION ALL SELECT owner, view_name, 'VIEW' FROM all_views WHERE ${USER_OWNED}
         ORDER BY 1, 2`,
        [],
        { outFormat: oracledb.OUT_FORMAT_ARRAY },
      );
      return (res.rows ?? []).map(([schema, name, type]) => ({ schema, name, type }));
    });
  }

  async describeTable(table: string, schema?: string): Promise<ColumnInfo[]> {
    return this.withConnection(async (conn) => {
      const binds: Record<string, string> = { t: table };
      let schemaFilter = '';
      if (schema) {
        binds.s = schema;
        schemaFilter = 'AND UPPER(owner) = UPPER(:s)';
      }
      const res = await conn.execute<[string, string, string]>(
        `SELECT column_name, data_type, nullable FROM all_tab_columns
         WHERE UPPER(table_name) = UPPER(:t) ${schemaFilter} AND ${USER_OWNED}
         ORDER BY column_id`,
        binds,
        { outFormat: oracledb.OUT_FORMAT_ARRAY },
      );
      return (res.rows ?? []).map(([name, type, nullable]) => ({ name, type, nullable: nullable === 'Y' }));
    });
  }

  async query(sql: string, { maxRows, timeoutMs }: QueryOptions): Promise<QueryResult> {
    return this.withConnection(async (conn) => {
      conn.callTimeout = timeoutMs;
      try {
        // Must be the first statement of the transaction; any write afterwards fails with ORA-01456.
        await conn.execute('SET TRANSACTION READ ONLY');
        const res = await conn.execute<unknown[]>(sql, [], {
          maxRows: maxRows + 1,
          outFormat: oracledb.OUT_FORMAT_ARRAY,
          autoCommit: false,
        });
        const rows = res.rows ?? [];
        return {
          columns: (res.metaData ?? []).map((m) => m.name),
          rows: rows.slice(0, maxRows),
          truncated: rows.length > maxRows,
        };
      } finally {
        await conn.rollback().catch(() => {});
      }
    });
  }

  async close(): Promise<void> {
    if (!this.poolPromise) return;
    const pool = await this.poolPromise.catch(() => undefined);
    await pool?.close(5);
  }
}
