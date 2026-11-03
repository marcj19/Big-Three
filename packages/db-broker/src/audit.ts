import { appendFile, mkdir } from 'node:fs/promises';
import path from 'node:path';

export interface AuditEntry {
  connection: string;
  tool: string;
  sql?: string;
  ok: boolean;
  rowCount?: number;
  error?: string;
}

export interface AuditLog {
  record(entry: AuditEntry): Promise<void>;
}

/** Append-only JSON Lines log of every call a model makes. Never contains credentials. */
export class FileAuditLog implements AuditLog {
  constructor(private readonly file: string) {}

  async record(entry: AuditEntry): Promise<void> {
    try {
      await mkdir(path.dirname(this.file), { recursive: true });
      await appendFile(this.file, JSON.stringify({ ts: new Date().toISOString(), ...entry }) + '\n');
    } catch {
      // Auditing must never take the broker down; the failure is visible as a missing line.
    }
  }
}

export const noAudit: AuditLog = { async record() {} };
