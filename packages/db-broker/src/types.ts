export type Engine = 'postgres' | 'mysql' | 'oracle';

/** Non-secret connection settings. The password lives in a SecretStore, never here. */
export interface ConnectionProfile {
  name: string;
  engine: Engine;
  host: string;
  port: number;
  /** Database name (Postgres/MySQL) or service name (Oracle). */
  database: string;
  user: string;
  ssl?: boolean;
  /** Extra Oracle built-in functions the guard should accept. */
  allowedFunctions?: string[];
}

export interface QueryOptions {
  maxRows: number;
  timeoutMs: number;
}

export interface QueryResult {
  columns: string[];
  rows: unknown[][];
  truncated: boolean;
}

export interface TableInfo {
  schema: string;
  name: string;
  type: string;
}

export interface ColumnInfo {
  name: string;
  type: string;
  nullable: boolean;
}

export interface Driver {
  listTables(): Promise<TableInfo[]>;
  describeTable(table: string, schema?: string): Promise<ColumnInfo[]>;
  /** Runs one already-validated statement inside a read-only transaction. */
  query(sql: string, opts: QueryOptions): Promise<QueryResult>;
  close(): Promise<void>;
}

export interface SecretStore {
  get(connectionName: string): Promise<string | undefined>;
}
