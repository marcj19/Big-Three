import { describe, expect, it } from 'vitest';
import { normalizeChatMarkdown, parseInline, parseMarkdown, safeLink } from '../src/renderer/markdown.js';
import { titleFrom } from '../src/services/conversations.js';

const kinds = (text: string) => parseMarkdown(text).map((b) => b.kind);

describe('inline Markdown', () => {
  it('reads bold, italic and code', () => {
    expect(parseInline('a **bold** and *slanted* and `code` here')).toEqual([
      { kind: 'text', value: 'a ' },
      { kind: 'bold', value: 'bold' },
      { kind: 'text', value: ' and ' },
      { kind: 'italic', value: 'slanted' },
      { kind: 'text', value: ' and ' },
      { kind: 'code', value: 'code' },
      { kind: 'text', value: ' here' },
    ]);
  });

  it('leaves arithmetic and stray marks alone', () => {
    expect(parseInline('17 * 3 * 2 = 102')).toEqual([{ kind: 'text', value: '17 * 3 * 2 = 102' }]);
    expect(parseInline('2*3*4')).toEqual([{ kind: 'text', value: '2*3*4' }]);
    expect(parseInline('an ** empty ** pair and a lone * star')).toEqual([{ kind: 'text', value: 'an ** empty ** pair and a lone * star' }]);
    expect(parseInline('unfinished **bold')).toEqual([{ kind: 'text', value: 'unfinished **bold' }]);
  });

  it('does not format inside code', () => {
    expect(parseInline('`**not bold**`')).toEqual([{ kind: 'code', value: '**not bold**' }]);
  });

  it('keeps markup and links as plain text, never as anything the window would interpret', () => {
    const parts = parseInline('<img src=x onerror=alert(1)> [click](javascript:alert(1)) <script>x</script>');
    expect(parts).toHaveLength(1);
    expect(parts[0]).toMatchObject({ kind: 'text' });
    expect(parts[0]!.value).toContain('<img src=x onerror=alert(1)>');
  });
});

describe('Markdown blocks', () => {
  it('splits paragraphs, headings, lists, quotes and code', () => {
    const text = ['# Title', '', 'Intro line', 'second line', '', '- one', '- **two**', '', '1. first', '2. second', '', '> quoted', '', '```ts', 'const x = 1;', '```', '', 'Done'].join('\n');
    expect(kinds(text)).toEqual(['heading', 'paragraph', 'list', 'list', 'quote', 'code', 'paragraph']);
    const blocks = parseMarkdown(text);
    expect(blocks[1]).toMatchObject({ kind: 'paragraph', inline: [{ kind: 'text', value: 'Intro line\nsecond line' }] });
    expect(blocks[2]).toMatchObject({ kind: 'list', ordered: false });
    expect(blocks[3]).toMatchObject({ kind: 'list', ordered: true });
    expect(blocks[5]).toEqual({ kind: 'code', value: 'const x = 1;', language: 'ts' });
  });

  it('shows a code block that is still streaming (no closing fence yet)', () => {
    expect(parseMarkdown('Here:\n```js\nconst a = 1;\nconst b')).toEqual([
      { kind: 'paragraph', inline: [{ kind: 'text', value: 'Here:' }] },
      { kind: 'code', value: 'const a = 1;\nconst b', language: 'js' },
    ]);
  });

  it('does not treat what is inside code as Markdown', () => {
    const blocks = parseMarkdown('```\n# not a heading\n- not a list\n```');
    expect(blocks).toEqual([{ kind: 'code', value: '# not a heading\n- not a list' }]);
  });

  it('caps deep headings at three levels and survives odd input', () => {
    expect(parseMarkdown('###### small')[0]).toMatchObject({ kind: 'heading', level: 3 });
    expect(parseMarkdown('')).toEqual([]);
    expect(parseMarkdown('\n\n  \n')).toEqual([]);
    expect(kinds('line one\r\nline two\r\n\r\nline three')).toEqual(['paragraph', 'paragraph']);
  });

  it('a heading or list directly after text starts a new block', () => {
    expect(kinds('Intro\n- a\n- b\n\nOutro')).toEqual(['paragraph', 'list', 'paragraph']);
  });

  it('renders the pasted escaped table and wrapped source links as structured content', () => {
    const text = ['\\| Necessidade | Sugestão |', '\\|---|---|', '\\| Raiz oleosa | **Exemplo** |', '',
      '[Fonte]\\([https://example.com/produto](https://example.com/produto))'].join('\n');
    const blocks = parseMarkdown(text);
    expect(blocks[0]).toMatchObject({ kind: 'table', rows: [[[{ kind: 'text', value: 'Raiz oleosa' }], [{ kind: 'bold', value: 'Exemplo' }]]] });
    expect(blocks[1]).toMatchObject({ kind: 'paragraph', inline: [{ kind: 'link', value: 'Fonte', href: 'https://example.com/produto' }] });
  });
  it('preserves nested lists, tasks, strikethrough and ordered numbering', () => {
    const blocks = parseMarkdown('3. Etapa\n   - [x] Conferido\n   - [ ] ~~Antigo~~\n\n> **Nota**\n>\n> Texto');
    expect(blocks[0]).toMatchObject({ kind: 'list', ordered: true, start: 3, items: [{ blocks: [
      { kind: 'paragraph' }, { kind: 'list', items: [{ checked: true }, { checked: false }] },
    ] }] });
    expect(blocks[1]).toMatchObject({ kind: 'quote', blocks: [{ kind: 'paragraph' }, { kind: 'paragraph' }] });
    expect(parseMarkdown('- [x] Conferido')[0]).toMatchObject({
      kind: 'list', items: [{ checked: true, blocks: [{ kind: 'paragraph', inline: [{ kind: 'text', value: 'Conferido' }] }] }],
    });
  });
  it('does not repair literal code or promote unsafe links and HTML into executable content', () => {
    const code = '```md\n\\| A | B |\n\\|---|---|\n```';
    expect(normalizeChatMarkdown(code)).toBe(code);
    for (const url of ['javascript:alert(1)', 'data:text/html,test', 'file:///C:/secret', 'https://user:pass@example.com']) expect(safeLink(url)).toBeUndefined();
    expect(parseInline('[site](https://example.com)')[0]).toMatchObject({ kind: 'link', href: 'https://example.com/' });
    expect(parseMarkdown('<script>alert(1)</script>')[0]).toMatchObject({ kind: 'paragraph', inline: [{ kind: 'text', value: '<script>alert(1)</script>' }] });
  });
});

describe('conversation titles', () => {
  it('keeps short prompts whole and cuts long ones on a word', () => {
    expect(titleFrom('  Explique   o que é um mutex ')).toBe('Explique o que é um mutex');
    const long = titleFrom('Pergunte ao Gemini quanto é 17 vezes 3 e me conte a resposta.');
    expect(long).toBe('Pergunte ao Gemini quanto é 17 vezes 3 e me…');
    expect(long.length).toBeLessThanOrEqual(49);
  });

  it('cuts a single huge word hard instead of returning nothing', () => {
    expect(titleFrom('x'.repeat(100))).toBe(`${'x'.repeat(48)}…`);
  });
});
