/** Accept local HTTP(S) URLs with an explicit port. */
export function localPreviewUrls(text: string): string[] {
  const urls = new Set<string>();
  const pattern = /https?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\]):\d{1,5}(?=\/|[\s)\x60"'\]>.,;!?]|$)(?:\/[^\s\x60"'<>\])}]*)?/gi;
  for (const match of text.matchAll(pattern)) {
    try {
      const url = new URL(match[0].replace(/[.,;!?]+$/, ''));
      if (url.hostname === '0.0.0.0') url.hostname = '127.0.0.1';
      if (!['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) || url.username || url.password) continue;
      urls.add(url.href);
      if (urls.size >= 8) break;
    } catch { /* invalid URL or port */ }
  }
  return [...urls];
}

/** Only use server banners from command output, rather than links found in files or search results. */
export function commandPreviews(output: string): string[] {
  const banners = output.slice(-32768).replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '').split(/\r?\n/)
    .filter((line) => /\b(?:local:|running (?:at|on)|listening (?:at|on)|available (?:at|on)|started (?:at|on))\s*/i.test(line));
  return localPreviewUrls(banners.join('\n'));
}
