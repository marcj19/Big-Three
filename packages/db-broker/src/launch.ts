import { fileURLToPath } from 'node:url';

/** Same shape as `McpServerSpec` in @aio/core; declared here so the broker stays independent of it. */
export interface BrokerServerSpec {
  name: string;
  command: string;
  args: string[];
  env: Record<string, string>;
}

export interface BrokerLaunchInput {
  /** Folder holding connections.json and the audit log. */
  configDir: string;
  /** Connections this session may see; omit for all of them. */
  connections?: string[];
  /** Override the server's entry file (defaults to the one next to this module). */
  entry?: string;
}

export const BROKER_SERVER_NAME = 'db';

/**
 * The database broker as an MCP server for a model CLI. The spec lands in a config file the model could read, so
 * it names only a folder and connection names: the password is read from the system vault by the broker itself.
 */
export function brokerServerSpec(input: BrokerLaunchInput): BrokerServerSpec {
  const ext = import.meta.url.endsWith('.ts') ? 'ts' : 'js';
  const entry = input.entry ?? fileURLToPath(new URL(`./server.${ext}`, import.meta.url));
  return {
    name: BROKER_SERVER_NAME,
    command: process.execPath,
    args: entry.endsWith('.ts') ? ['--import', import.meta.resolve('tsx'), entry] : [entry],
    env: {
      AIO_CONFIG_DIR: input.configDir,
      ...(input.connections?.length ? { AIO_CONNECTIONS: input.connections.join(',') } : {}),
      // Inside Electron the "node" to run is the app binary itself, which must be told to behave as plain node.
      ...(process.versions.electron ? { ELECTRON_RUN_AS_NODE: '1' } : {}),
    },
  };
}
