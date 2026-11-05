/** Browser navigation is separate from the app's own file origin and IPC. */
export function browserUrl(input: string): string {
  const text = input.trim();
  if (!text || text.length > 4000 || /[\u0000-\u0020]/.test(text)) throw new Error('Informe um endereço HTTP ou HTTPS válido.');
  const hasProtocol = /^[a-z][a-z0-9+.-]*:\/\//i.test(text);
  if (!hasProtocol && /^[a-z][a-z0-9+.-]*:/i.test(text) && !/^[^/:]+:\d+(?:\/|$)/.test(text)) throw new Error('Use somente endereços HTTP ou HTTPS.');
  let url: URL;
  try { url = new URL(hasProtocol ? text : `${/^(localhost|127\.\d+\.\d+\.\d+|\[::1\])(?::|\/|$)/i.test(text) ? 'http' : 'https'}://${text}`); }
  catch { throw new Error('Informe um endereço válido, como https://example.com ou localhost:3000.'); }
  if (!['http:', 'https:'].includes(url.protocol) || !url.hostname || url.username || url.password) throw new Error('Use somente endereços HTTP ou HTTPS sem credenciais no endereço.');
  return url.href;
}
export function isBrowserUrl(url: string): boolean { try { browserUrl(url); return /^https?:\/\//i.test(url); } catch { return false; } }
