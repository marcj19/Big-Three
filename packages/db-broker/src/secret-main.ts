#!/usr/bin/env node
import { runSecretCli } from './secret-cli.js';
import { KeyringSecretStore } from './secrets.js';

/** Reads a line without echoing it (TTY), or the whole of stdin when the password is piped in by the app. */
async function readSecret(prompt: string): Promise<string> {
  const stdin = process.stdin;
  if (!stdin.isTTY) {
    const chunks: Buffer[] = [];
    for await (const chunk of stdin) chunks.push(chunk as Buffer);
    return Buffer.concat(chunks).toString('utf8').replace(/\r?\n$/, '');
  }
  process.stderr.write(prompt);
  stdin.setRawMode(true);
  stdin.resume();
  stdin.setEncoding('utf8');
  return new Promise((resolve, reject) => {
    let typed = '';
    const finish = (fn: () => void) => {
      stdin.setRawMode(false);
      stdin.pause();
      stdin.off('data', onData);
      process.stderr.write('\n');
      fn();
    };
    const onData = (chunk: string) => {
      for (const ch of chunk) {
        if (ch === '\r' || ch === '\n') return finish(() => resolve(typed));
        if (ch === '\u0003') return finish(() => reject(new Error('Cancelled')));
        if (ch === '\u007f' || ch === '\b') typed = typed.slice(0, -1);
        else typed += ch;
      }
    };
    stdin.on('data', onData);
  });
}

runSecretCli(process.argv.slice(2), {
  store: new KeyringSecretStore(),
  readSecret,
  out: (line) => console.log(line),
})
  .then((code) => {
    process.exitCode = code;
  })
  .catch((err) => {
    // Only the error's own message: it comes from the vault or the prompt and never contains the password.
    console.error(err instanceof Error ? err.message : 'Failed');
    process.exitCode = 1;
  });
