import { Lexer, Marked, Tokenizer, type Token, type Tokens } from 'marked';

/** Tokens only; remote HTML is never handed to a browser parser. */
export type Inline = { kind: 'text' | 'bold' | 'italic' | 'code' | 'strike' | 'link' | 'break'; value: string; href?: string; children?: Inline[] };
export type Block =
  | { kind: 'paragraph'; inline: Inline[] }
  | { kind: 'heading'; level: 1 | 2 | 3; inline: Inline[] }
  | { kind: 'list'; ordered: boolean; start: number; items: { blocks: Block[]; checked?: boolean }[] }
  | { kind: 'quote'; blocks: Block[] }
  | { kind: 'table'; header: Inline[][]; rows: Inline[][][]; align: (string | null)[] }
  | { kind: 'rule' }
  | { kind: 'code'; value: string; language?: string };

export function safeLink(value: string): string | undefined {
  try { const url = new URL(value); return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password ? url.href : undefined; }
  catch { return undefined; }
}

const localFile = /^file:\/\/\//i;
const escapedFileLink = /\[(?:\\?`[^`\r\n]+\\?`|[^\[\]\r\n]+)\]\\\((?=<?file:\/\/\/)/i;
const chatMarkdown = new Marked().use({
  gfm: true,
  extensions: [{
    name: 'escapedFileLink', level: 'inline',
    start(src) { return escapedFileLink.exec(src)?.index; },
    tokenizer(src) {
      if (src[0] !== '[') return;
      const match = escapedFileLink.exec(src);
      if (match?.index !== 0) return;
      // Let Marked find the matching parenthesis, including paths such as app/(app)/page.tsx.
      const opener = match[0].length - 2;
      const tokenizer = new Tokenizer();
      new Lexer({ gfm: true, tokenizer });
      const link = tokenizer.link(src.slice(0, opener) + src.slice(opener + 1));
      if (link?.type !== 'link' || !localFile.test(link.href)) return;
      return { ...link, raw: src.slice(0, link.raw.length + 1) };
    },
  }],
});

function inlineTokens(tokens: Token[]): Inline[] {
  const result: Inline[] = [];
  const text = (value: string) => {
    if (!value) return;
    const previous = result.at(-1);
    if (previous?.kind === 'text') previous.value += value;
    else result.push({ kind: 'text', value });
  };
  for (const token of tokens) {
    switch (token.type) {
      case 'strong': case 'em': case 'del': {
        const span = token as Tokens.Strong;
        const children = inlineTokens(span.tokens);
        const plain = children.every((child) => child.kind === 'text');
        result.push({ kind: token.type === 'strong' ? 'bold' : token.type === 'em' ? 'italic' : 'strike',
          value: plain ? children.map((child) => child.value).join('') : span.text, ...(plain ? {} : { children }) });
        break;
      }
      case 'codespan': result.push({ kind: 'code', value: token.text }); break;
      case 'link': case 'image': {
        const link = token as Tokens.Link;
        if (token.type === 'link' && link.text && localFile.test(link.href)) {
          const code = /^\\`([^`\r\n]+)\\`$/.exec(link.text);
          if (code) result.push({ kind: 'code', value: code[1]! });
          else result.push(...inlineTokens(link.tokens));
          break;
        }
        const href = safeLink(link.href);
        if (!href) text(token.raw);
        else result.push({ kind: 'link', value: link.text || href, href, ...(link.tokens ? { children: inlineTokens(link.tokens) } : {}) });
        break;
      }
      case 'br': result.push({ kind: 'break', value: '' }); break;
      case 'escape': text(token.text); break;
      case 'text': if (token.tokens) result.push(...inlineTokens(token.tokens)); else text(token.text); break;
      default: text(token.raw);
    }
  }
  return result;
}
export function parseInline(text: string): Inline[] {
  if (/^[\d\s*+\-/=().,]+$/.test(text)) return [{ kind: 'text', value: text }];
  return inlineTokens(Lexer.lexInline(text, chatMarkdown.defaults));
}

/** Repairs escaped table borders and wrapped links pasted from another chat, outside code fences. */
export function normalizeChatMarkdown(text: string): string {
  let fence: string | undefined;
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  const first = lines.findIndex((line) => line.trim());
  const opening = lines[first] ?? '';
  // A single pipe glued to an opening sentence is stray markup unless a table divider follows.
  if (/^\|[\p{L}*][^|]*\s[^|]*$/u.test(opening) && !/^\s*\\?\|?\s*:?-+:?\s*\|?\s*$/.test(lines[first + 1] ?? '')) {
    lines[first] = opening.slice(1);
  }
  return lines.map((line) => {
    const marker = /^\s{0,3}(`{3,}|~{3,})/.exec(line)?.[1];
    if (marker) { if (!fence) fence = marker; else if (marker[0] === fence[0] && marker.length >= fence.length && /^\s{0,3}(?:`+|~+)\s*$/.test(line)) fence = undefined; return line; }
    if (fence || /^ {4}|^\t/.test(line)) return line;
    return line.replace(/^(\s*)\\\|/, '$1|')
      .replace(/\[([^\]\n]+)\]\\\(\[(https?:\/\/[^\s\]]+)\]\((https?:\/\/[^\s)]+)\)\)/g,
        (all, label: string, shown: string, href: string) => shown === href ? `[${label}](${href})` : all);
  }).join('\n');
}
function blocks(tokens: Token[], depth = 0): Block[] {
  if (depth > 12) return [{ kind: 'paragraph', inline: [{ kind: 'text', value: tokens.map((t) => t.raw).join('') }] }];
  const result: Block[] = [];
  for (const token of tokens) {
    switch (token.type) {
      case 'space': case 'def': case 'checkbox': break;
      case 'heading': result.push({ kind: 'heading', level: Math.min(token.depth, 3) as 1 | 2 | 3, inline: inlineTokens(token.tokens ?? []) }); break;
      case 'code': result.push({ kind: 'code', value: token.text, ...(token.lang ? { language: token.lang.split(/\s/)[0] } : {}) }); break;
      case 'blockquote': result.push({ kind: 'quote', blocks: blocks(token.tokens ?? [], depth + 1) }); break;
      case 'list': result.push({ kind: 'list', ordered: token.ordered, start: Number(token.start) || 1,
        items: token.items.map((item: Tokens.ListItem) => ({ blocks: blocks(item.tokens, depth + 1), ...(item.task ? { checked: item.checked === true } : {}) })) }); break;
      case 'table': result.push({ kind: 'table', header: token.header.map((cell: Tokens.TableCell) => inlineTokens(cell.tokens)),
        rows: token.rows.map((row: Tokens.TableCell[]) => row.map((cell) => inlineTokens(cell.tokens))), align: token.align }); break;
      case 'hr': result.push({ kind: 'rule' }); break;
      case 'paragraph': case 'text': result.push({ kind: 'paragraph', inline: token.tokens ? inlineTokens(token.tokens) : parseInline(token.text) }); break;
      default: result.push({ kind: 'paragraph', inline: [{ kind: 'text', value: token.raw }] });
    }
  }
  return result;
}
export function parseMarkdown(text: string): Block[] { return blocks(chatMarkdown.lexer(normalizeChatMarkdown(text))); }
