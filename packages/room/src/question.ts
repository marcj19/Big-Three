import type { UserQuestion } from '@aio/core';

const OPEN = '<aio-question>';

function questionStart(text: string, streaming = false): number | undefined {
  if (!text.includes(OPEN)) {
    if (!streaming) return;
    const last = text.slice(text.lastIndexOf('\n') + 1).replace(/^ {0,3}\\?/, '');
    if (!last || !OPEN.startsWith(last)) return;
  }
  const lines = text.split('\n');
  let fence: string | undefined;
  let offset = 0;
  for (const [index, line] of lines.entries()) {
    const marker = /^ {0,3}(\x60{3,}|~{3,})(.*)$/.exec(line);
    if (marker) {
      const delimiter = marker[1]!;
      if (!fence) fence = delimiter;
      else if (delimiter[0] === fence[0] && delimiter.length >= fence.length && !marker[2]!.trim()) fence = undefined;
    } else if (!fence && !/^(?: {4}|\t)/.test(line)) {
      const candidate = line.replace(/^ {0,3}\\?/, '');
      if (candidate.startsWith(OPEN)) return offset;
      if (streaming && index === lines.length - 1 && candidate && OPEN.startsWith(candidate)) return offset;
    }
    offset += line.length + 1;
  }
}

/** Show the reply as it streams, withholding the question protocol until the form is ready. */
export function visibleReply(text: string): string {
  const start = questionStart(text, true);
  return start === undefined ? text : text.slice(0, start).trimEnd();
}

/** Read a trailing question on its own line, with or without Markdown escaping. */
export function splitQuestion(text: string): { body: string; question: UserQuestion } | undefined {
  const start = questionStart(text);
  if (start === undefined) return;
  const match = /^\\?<aio-question>\s*([\s\S]+?)\s*\\?<\/aio-question>$/.exec(text.slice(start).trim());
  if (!match || match[1]!.length > 10000) return;
  try {
    const value = JSON.parse(match[1]!) as Partial<UserQuestion> | null;
    const question = typeof value?.question === 'string' ? value.question.trim().slice(0, 4000) : '';
    if (!question) return;
    const options = Array.isArray(value?.options)
      ? [...new Set(value.options.filter((option) => typeof option === 'string').map((option) => option.trim().slice(0, 200)).filter(Boolean))].slice(0, 6)
      : [];
    return { body: text.slice(0, start).trimEnd(), question: { question, options } };
  } catch { return; }
}
