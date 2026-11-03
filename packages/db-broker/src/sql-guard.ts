import type { Engine } from './types.js';

export class SqlGuardError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SqlGuardError';
  }
}

export interface GuardOptions {
  /** Extra function names accepted by the Oracle function allowlist. */
  allowedFunctions?: string[];
}

const MAX_SQL_LENGTH = 20_000;

type TokenKind = 'word' | 'ident' | 'literal' | 'punct';
interface Token {
  kind: TokenKind;
  /** word: uppercased; ident: inner text; literal: ''; punct: the character. */
  value: string;
}

const isWordStart = (c: string) => /[A-Za-z_]/.test(c) || c > '\x7f';
const isWordPart = (c: string) => /[A-Za-z0-9_$#]/.test(c) || c > '\x7f';

function skipQuoted(sql: string, start: number, quote: string, backslash: boolean): { end: number; text: string } {
  let i = start + 1;
  let text = '';
  while (i < sql.length) {
    const ch = sql[i]!;
    if (backslash && ch === '\\') {
      text += sql[i + 1] ?? '';
      i += 2;
    } else if (ch === quote) {
      if (sql[i + 1] === quote) {
        text += quote;
        i += 2;
      } else {
        return { end: i + 1, text };
      }
    } else {
      text += ch;
      i++;
    }
  }
  throw new SqlGuardError('Unterminated quoted string or identifier');
}

function skipBlockComment(sql: string, start: number, nested: boolean): number {
  let depth = 1;
  let i = start + 2;
  while (i < sql.length) {
    if (nested && sql[i] === '/' && sql[i + 1] === '*') {
      depth++;
      i += 2;
    } else if (sql[i] === '*' && sql[i + 1] === '/') {
      depth--;
      i += 2;
      if (depth === 0) return i;
    } else {
      i++;
    }
  }
  throw new SqlGuardError('Unterminated block comment');
}

function skipOracleQQuote(sql: string, quotePos: number): number {
  const open = sql[quotePos + 1];
  if (open === undefined || /\s/.test(open)) throw new SqlGuardError('Invalid q-quote delimiter');
  const close = ({ '[': ']', '(': ')', '{': '}', '<': '>' } as Record<string, string>)[open] ?? open;
  const idx = sql.indexOf(close + "'", quotePos + 2);
  if (idx === -1) throw new SqlGuardError('Unterminated q-quoted string');
  return idx + 2;
}

/**
 * Splits SQL into tokens, discarding comments and string contents so keyword checks
 * cannot be fooled by (or fire on) text inside literals. Quoting rules differ per
 * engine; anything ambiguous fails closed with a SqlGuardError.
 */
function tokenize(sql: string, engine: Engine): Token[] {
  const tokens: Token[] = [];
  const n = sql.length;
  let i = 0;

  const skipLine = () => {
    const end = sql.indexOf('\n', i);
    i = end === -1 ? n : end + 1;
  };

  while (i < n) {
    const c = sql[i]!;
    const next = sql[i + 1];

    if (/\s/.test(c)) {
      i++;
      continue;
    }

    // `--` is only a comment in MySQL when followed by whitespace; otherwise it is two minus signs.
    if (c === '-' && next === '-') {
      const after = sql[i + 2];
      if (engine !== 'mysql' || after === undefined || /[\s\x00-\x1f]/.test(after)) {
        skipLine();
        continue;
      }
    }
    if (engine === 'mysql' && c === '#') {
      skipLine();
      continue;
    }
    if (c === '/' && next === '*') {
      if (engine === 'mysql' && (sql[i + 2] === '!' || (sql[i + 2] === 'M' && sql[i + 3] === '!'))) {
        throw new SqlGuardError('MySQL executable comments (/*! ... */) are not allowed');
      }
      i = skipBlockComment(sql, i, engine === 'postgres');
      continue;
    }

    if (c === "'") {
      const r = skipQuoted(sql, i, "'", engine === 'mysql');
      tokens.push({ kind: 'literal', value: '' });
      i = r.end;
      continue;
    }
    if (c === '"' || c === '`') {
      const r = skipQuoted(sql, i, c, engine === 'mysql' && c === '"');
      tokens.push({ kind: 'ident', value: r.text });
      i = r.end;
      continue;
    }

    if (engine === 'postgres' && c === '$') {
      const m = /^\$([A-Za-z_\u0080-￿][A-Za-z0-9_\u0080-￿]*)?\$/.exec(sql.slice(i));
      if (m) {
        const tag = m[0];
        const close = sql.indexOf(tag, i + tag.length);
        if (close === -1) throw new SqlGuardError('Unterminated dollar-quoted string');
        tokens.push({ kind: 'literal', value: '' });
        i = close + tag.length;
        continue;
      }
    }

    if (/[0-9]/.test(c)) {
      let j = i + 1;
      while (j < n && /[0-9A-Za-z_.]/.test(sql[j]!)) j++;
      tokens.push({ kind: 'literal', value: '' });
      i = j;
      continue;
    }

    if (isWordStart(c)) {
      let j = i + 1;
      while (j < n && isWordPart(sql[j]!)) j++;
      const upper = sql.slice(i, j).toUpperCase();
      if (sql[j] === "'") {
        if (engine === 'postgres' && upper === 'E') {
          const r = skipQuoted(sql, j, "'", true);
          tokens.push({ kind: 'literal', value: '' });
          i = r.end;
          continue;
        }
        if (engine === 'oracle' && (upper === 'Q' || upper === 'NQ')) {
          tokens.push({ kind: 'literal', value: '' });
          i = skipOracleQQuote(sql, j);
          continue;
        }
      }
      tokens.push({ kind: 'word', value: upper });
      i = j;
      continue;
    }

    tokens.push({ kind: 'punct', value: c });
    i++;
  }
  return tokens;
}

/** Keywords that must not appear anywhere in a statement (catches writes nested in CTEs, SELECT INTO, locks). */
const DENIED_KEYWORDS = new Set([
  'INSERT', 'UPDATE', 'DELETE', 'MERGE', 'INTO', 'LOCK',
  'DROP', 'ALTER', 'CREATE', 'TRUNCATE', 'GRANT', 'REVOKE',
  'CALL', 'EXEC', 'EXECUTE', 'COPY', 'DO', 'DECLARE',
]);

/** Functions that read files, run dynamic SQL, sleep, change state or reach other servers. Matched case-insensitively. */
const DENIED_FUNCTIONS = new Set([
  'pg_read_file', 'pg_read_binary_file', 'pg_ls_dir', 'pg_stat_file', 'pg_ls_logdir', 'pg_ls_waldir',
  'lo_import', 'lo_export', 'lo_get', 'lo_from_bytea', 'lo_put',
  'pg_sleep', 'pg_terminate_backend', 'pg_cancel_backend', 'pg_reload_conf', 'pg_rotate_logfile',
  'set_config', 'nextval', 'setval', 'pg_advisory_lock', 'pg_try_advisory_lock',
  'query_to_xml', 'query_to_xml_and_xmlschema', 'query_to_xmlschema', 'cursor_to_xml',
  'table_to_xml', 'database_to_xml', 'schema_to_xml',
  'load_file', 'sleep', 'benchmark', 'get_lock', 'release_lock',
]);

const DENIED_FUNCTION_PREFIXES = ['dblink', 'dbms_', 'utl_', 'pg_file_', 'ctxsys'];

/** Words that may legitimately precede `(` in an Oracle query without being a function call. */
const ORACLE_KEYWORDS_BEFORE_PAREN = new Set([
  'SELECT', 'FROM', 'WHERE', 'AND', 'OR', 'NOT', 'IN', 'EXISTS', 'ANY', 'SOME', 'ALL', 'ON', 'USING',
  'JOIN', 'UNION', 'INTERSECT', 'MINUS', 'EXCEPT', 'BY', 'OVER', 'PARTITION', 'ORDER', 'GROUP', 'HAVING',
  'BETWEEN', 'WHEN', 'THEN', 'ELSE', 'END', 'CASE', 'IS', 'LIKE', 'DISTINCT', 'UNIQUE', 'AS', 'WITH',
  'CONNECT', 'START', 'PRIOR', 'FETCH', 'FIRST', 'NEXT', 'ROWS', 'ONLY', 'OFFSET', 'VALUES', 'KEEP',
  'WITHIN', 'LATERAL', 'CROSS', 'INNER', 'LEFT', 'RIGHT', 'FULL', 'OUTER', 'NATURAL', 'NULLS',
  // type names used inside CAST(... AS NUMBER(10,2))
  'NUMBER', 'VARCHAR', 'VARCHAR2', 'NVARCHAR2', 'CHAR', 'NCHAR', 'DECIMAL', 'NUMERIC', 'FLOAT',
  'TIMESTAMP', 'INTERVAL', 'DATE', 'RAW',
]);

const ORACLE_ALLOWED_FUNCTIONS = new Set([
  'COUNT', 'SUM', 'AVG', 'MIN', 'MAX', 'MEDIAN', 'STDDEV', 'VARIANCE',
  'NVL', 'NVL2', 'COALESCE', 'NULLIF', 'DECODE', 'GREATEST', 'LEAST',
  'ABS', 'CEIL', 'FLOOR', 'ROUND', 'TRUNC', 'MOD', 'POWER', 'SQRT', 'SIGN', 'EXP', 'LN', 'LOG',
  'TO_CHAR', 'TO_DATE', 'TO_NUMBER', 'TO_TIMESTAMP', 'CAST',
  'UPPER', 'LOWER', 'INITCAP', 'SUBSTR', 'INSTR', 'LENGTH', 'LPAD', 'RPAD', 'LTRIM', 'RTRIM', 'TRIM',
  'REPLACE', 'TRANSLATE', 'CONCAT', 'ASCII', 'CHR', 'SOUNDEX',
  'REGEXP_LIKE', 'REGEXP_SUBSTR', 'REGEXP_REPLACE', 'REGEXP_INSTR', 'REGEXP_COUNT',
  'ADD_MONTHS', 'MONTHS_BETWEEN', 'LAST_DAY', 'NEXT_DAY', 'EXTRACT', 'NUMTODSINTERVAL', 'NUMTOYMINTERVAL',
  'ROW_NUMBER', 'RANK', 'DENSE_RANK', 'PERCENT_RANK', 'CUME_DIST', 'NTILE', 'LAG', 'LEAD',
  'FIRST_VALUE', 'LAST_VALUE', 'NTH_VALUE', 'LISTAGG', 'RATIO_TO_REPORT',
  'JSON_VALUE', 'JSON_QUERY', 'JSON_EXISTS', 'JSON_TABLE',
]);

export function assertReadOnlySelect(sql: string, engine: Engine, opts: GuardOptions = {}): void {
  if (typeof sql !== 'string' || sql.trim() === '') throw new SqlGuardError('Empty query');
  if (sql.length > MAX_SQL_LENGTH) throw new SqlGuardError(`Query longer than ${MAX_SQL_LENGTH} characters`);
  if (sql.includes('\0')) throw new SqlGuardError('Query contains a NUL character');

  const tokens = tokenize(sql, engine);

  const last = tokens[tokens.length - 1];
  if (last?.kind === 'punct' && last.value === ';') tokens.pop();
  if (tokens.some((t) => t.kind === 'punct' && t.value === ';')) {
    throw new SqlGuardError('Only a single statement is allowed');
  }

  const first = tokens[0];
  if (!first || first.kind !== 'word' || (first.value !== 'SELECT' && first.value !== 'WITH')) {
    throw new SqlGuardError('Only SELECT queries (optionally starting with WITH) are allowed');
  }

  const extraFunctions = new Set((opts.allowedFunctions ?? []).map((f) => f.toUpperCase()));

  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i]!;
    const next = tokens[i + 1];

    if (t.kind === 'word') {
      if (DENIED_KEYWORDS.has(t.value)) throw new SqlGuardError(`Keyword not allowed: ${t.value}`);
      if (t.value === 'FOR' && next?.kind === 'word' && ['SHARE', 'NO', 'KEY'].includes(next.value)) {
        throw new SqlGuardError('Row-locking clauses (FOR SHARE / FOR NO KEY UPDATE) are not allowed');
      }
    }

    if (t.kind === 'word' || t.kind === 'ident') {
      const lower = t.value.toLowerCase();
      if (DENIED_FUNCTIONS.has(lower) || DENIED_FUNCTION_PREFIXES.some((p) => lower.startsWith(p))) {
        throw new SqlGuardError(`Function or object not allowed: ${t.value}`);
      }
    }

    if (engine === 'oracle' && (t.kind === 'word' || t.kind === 'ident') && next?.kind === 'punct' && next.value === '(') {
      const name = t.value.toUpperCase();
      const known = t.kind === 'word' && (ORACLE_KEYWORDS_BEFORE_PAREN.has(name) || ORACLE_ALLOWED_FUNCTIONS.has(name));
      if (!known && !extraFunctions.has(name)) {
        throw new SqlGuardError(`Function not on the Oracle allowlist: ${t.value}`);
      }
    }
  }
}
