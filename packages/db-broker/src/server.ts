#!/usr/bin/env node
import path from 'node:path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { FileAuditLog } from './audit.js';
import { Broker } from './broker.js';
import { configDir, EnvSecretStore, loadProfiles, selectProfiles } from './config.js';
import { ChainedSecretStore, KeyringSecretStore } from './secrets.js';

const asText = (value: unknown) => ({ content: [{ type: 'text' as const, text: JSON.stringify(value, null, 2) }] });
const asError = (err: unknown) => ({
  isError: true,
  content: [{ type: 'text' as const, text: err instanceof Error ? err.message : 'Unexpected error' }],
});

async function main() {
  const broker = new Broker({
    // AIO_CONNECTIONS narrows what this session may see; the config file may hold more connections.
    profiles: selectProfiles(await loadProfiles(), process.env.AIO_CONNECTIONS),
    // The vault first: it works even when a model CLI started this process with a scrubbed environment.
    // The environment is a fallback for development and tests.
    secrets: new ChainedSecretStore([new KeyringSecretStore(), new EnvSecretStore()]),
    audit: new FileAuditLog(path.join(configDir(), 'audit.jsonl')),
  });

  const server = new McpServer({ name: 'aio-db-broker', version: '0.1.0' });
  const guard = <A>(fn: (args: A) => Promise<unknown>) => async (args: A) => {
    try {
      return asText(await fn(args));
    } catch (err) {
      return asError(err);
    }
  };

  server.registerTool(
    'list_connections',
    { description: 'List the database connections you can query (name and engine only).' },
    guard(async () => broker.listConnections()),
  );

  server.registerTool(
    'list_schema',
    {
      description: 'List the tables and views of a connection.',
      inputSchema: { connection: z.string().describe('Connection name from list_connections') },
    },
    guard(async ({ connection }: { connection: string }) => broker.listSchema(connection)),
  );

  server.registerTool(
    'describe_table',
    {
      description: 'List the columns, types and nullability of one table.',
      inputSchema: {
        connection: z.string(),
        table: z.string(),
        schema: z.string().optional().describe('Schema/owner, when the table name is ambiguous'),
      },
    },
    guard(async ({ connection, table, schema }: { connection: string; table: string; schema?: string }) =>
      broker.describeTable(connection, table, schema),
    ),
  );

  server.registerTool(
    'run_select',
    {
      description:
        'Run ONE read-only SELECT (or WITH ... SELECT) statement. Writes, DDL, multiple statements and locking clauses are rejected. Results are row-limited.',
      inputSchema: {
        connection: z.string(),
        sql: z.string().describe('A single SELECT statement'),
        max_rows: z.number().int().positive().optional().describe('Row cap (the broker enforces its own ceiling)'),
      },
    },
    guard(async ({ connection, sql, max_rows }: { connection: string; sql: string; max_rows?: number }) =>
      broker.runSelect(connection, sql, max_rows),
    ),
  );

  const shutdown = async () => {
    await broker.close();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  await server.connect(new StdioServerTransport());
}

// stdout carries the MCP protocol, so diagnostics go to stderr and never include secrets.
main().catch((err) => {
  console.error('aio-db-broker failed to start:', err instanceof Error ? err.message : err);
  process.exit(1);
});
