const MAX_ERROR_LENGTH = 500;

/** Removes anything that could reveal how to reach the database from an error message. */
export function sanitizeError(err: unknown, sensitive: string[]): string {
  let message = err instanceof Error ? err.message : String(err);
  for (const value of sensitive) {
    if (value.length >= 3) message = message.split(value).join('[redacted]');
  }
  message = message.replace(/\b[a-z][a-z0-9+.-]*:\/\/\S+/gi, '[redacted-url]');
  return message.length > MAX_ERROR_LENGTH ? `${message.slice(0, MAX_ERROR_LENGTH)}…` : message;
}

/** Makes driver values JSON-safe and bounds the size of any single cell. */
export function normalizeValue(value: unknown, maxCellChars: number): unknown {
  if (value === null || value === undefined) return null;
  if (typeof value === 'bigint') return value.toString();
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value.toISOString();
  if (Buffer.isBuffer(value)) return `<binary ${value.length} bytes>`;
  if (typeof value === 'string') {
    return value.length > maxCellChars ? `${value.slice(0, maxCellChars)}… [${value.length - maxCellChars} more chars]` : value;
  }
  if (typeof value === 'object') {
    const text = JSON.stringify(value, (_k, v) => (typeof v === 'bigint' ? v.toString() : v));
    return text.length > maxCellChars ? `${text.slice(0, maxCellChars)}…` : JSON.parse(text);
  }
  return value;
}
