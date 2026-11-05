import type { UserQuestion } from '@aio/core';

export function parseQuestion(text: string): UserQuestion | undefined {
  const match = /^<aio-question>\s*([\s\S]+?)\s*<\/aio-question>$/.exec(text.trim());
  if (!match || match[1]!.length > 10000) return;
  try {
    const value = JSON.parse(match[1]!) as Partial<UserQuestion> | null;
    const question = typeof value?.question === 'string' ? value.question.trim().slice(0, 4000) : '';
    if (!question) return;
    const options = Array.isArray(value?.options)
      ? [...new Set(value.options.filter((option) => typeof option === 'string').map((option) => option.trim().slice(0, 200)).filter(Boolean))].slice(0, 6)
      : [];
    return { question, options };
  } catch { return; }
}
