/**
 * A small, safe subset of Markdown for model replies: paragraphs, headings, lists, quotes, fenced code, and inline
 * **bold**, *italic* and `code`. It only produces data (never HTML): the window builds elements from these pieces
 * and inserts every string as text, so nothing a model writes can become markup. Links are left as plain text.
 */
export type Inline = { kind: 'text' | 'bold' | 'italic' | 'code'; value: string };
export type Block =
  | { kind: 'paragraph'; inline: Inline[] }
  | { kind: 'heading'; level: 1 | 2 | 3; inline: Inline[] }
  | { kind: 'list'; ordered: boolean; items: Inline[][] }
  | { kind: 'quote'; inline: Inline[] }
  | { kind: 'code'; value: string };

/** Inline spans. Emphasis needs non-space text right inside the marks, so `17 * 3 * 2` stays arithmetic. */
export function parseInline(text: string): Inline[] {
  const out: Inline[] = [];
  const push = (kind: Inline['kind'], value: string) => {
    if (!value) return;
    const last = out[out.length - 1];
    if (kind === 'text' && last?.kind === 'text') last.value += value;
    else out.push({ kind, value });
  };
  let i = 0;
  while (i < text.length) {
    const rest = text.slice(i);
    let m: RegExpExecArray | null;
    if ((m = /^`([^`\n]+)`/.exec(rest))) {
      push('code', m[1]!);
      i += m[0].length;
    } else if ((m = /^\*\*(?=\S)([^\n]*?\S)\*\*/.exec(rest))) {
      push('bold', m[1]!);
      i += m[0].length;
    } else if ((m = /^\*(?=[^\s*])([^\n*]*?[^\s*])\*(?![*\w])/.exec(rest)) && !/\w/.test(text[i - 1] ?? '')) {
      push('italic', m[1]!);
      i += m[0].length;
    } else {
      push('text', text[i]!);
      i++;
    }
  }
  return out;
}

const BULLET = /^\s{0,3}[-*+]\s+(.*)$/;
const NUMBERED = /^\s{0,3}\d+[.)]\s+(.*)$/;

export function parseMarkdown(text: string): Block[] {
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  const blocks: Block[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    if (!line.trim()) {
      i++;
      continue;
    }
    if (/^\s*```/.test(line)) {
      // An unterminated fence (the reply is still streaming) takes everything up to the end.
      const body: string[] = [];
      i++;
      while (i < lines.length && !/^\s*```\s*$/.test(lines[i]!)) body.push(lines[i++]!);
      i++;
      blocks.push({ kind: 'code', value: body.join('\n') });
      continue;
    }
    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading) {
      blocks.push({ kind: 'heading', level: Math.min(heading[1]!.length, 3) as 1 | 2 | 3, inline: parseInline(heading[2]!.trim()) });
      i++;
      continue;
    }
    const kind = BULLET.test(line) ? 'bullet' : NUMBERED.test(line) ? 'numbered' : undefined;
    if (kind) {
      const pattern = kind === 'bullet' ? BULLET : NUMBERED;
      const items: Inline[][] = [];
      while (i < lines.length && pattern.test(lines[i]!)) items.push(parseInline(pattern.exec(lines[i++]!)![1]!));
      blocks.push({ kind: 'list', ordered: kind === 'numbered', items });
      continue;
    }
    if (/^\s{0,3}>\s?/.test(line)) {
      const quoted: string[] = [];
      while (i < lines.length && /^\s{0,3}>\s?/.test(lines[i]!)) quoted.push(lines[i++]!.replace(/^\s{0,3}>\s?/, ''));
      blocks.push({ kind: 'quote', inline: parseInline(quoted.join('\n')) });
      continue;
    }
    const para: string[] = [];
    while (i < lines.length && lines[i]!.trim() && !/^\s*```/.test(lines[i]!) && !/^#{1,6}\s/.test(lines[i]!) && !BULLET.test(lines[i]!) && !NUMBERED.test(lines[i]!) && !/^\s{0,3}>/.test(lines[i]!)) {
      para.push(lines[i++]!);
    }
    blocks.push({ kind: 'paragraph', inline: parseInline(para.join('\n')) });
  }
  return blocks;
}
