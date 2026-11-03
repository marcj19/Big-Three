// A stand-in for a model CLI. Reads the prompt from stdin, then behaves according to FAKE_MODE (set via the
// first CLI argument after the script when invoked as `node fake-cli.mjs <mode> ...flags`).
import { existsSync, readFileSync, writeFileSync } from 'node:fs';

const [mode, ...flags] = process.argv.slice(2);
// `replay <file>` prints a recorded JSONL stream verbatim.
if (mode === 'replay') {
  process.stdout.write(readFileSync(flags[0], 'utf8'));
  process.exit(0);
}
const stdin = readFileSync(0, 'utf8');
const out = (o) => process.stdout.write(JSON.stringify(o) + '\n');

if (flags.includes('--version')) {
  console.log('9.9.9-fake');
  process.exit(0);
}

switch (mode) {
  case 'authcli':
  case 'authcli-stuck': {
    // Simulates `claude auth status|login`: signed-in state lives in the file given as the first flag.
    const [stateFile, , sub, action] = flags; // flags = [stateFile, 'auth', 'status' | 'login', '--claudeai']
    if (sub === 'status') {
      const signedIn = existsSync(stateFile);
      out({ loggedIn: signedIn, authMethod: signedIn ? 'claude.ai' : 'none' });
      // exitCode, not exit(): exit() can drop output still queued on a pipe.
      process.exitCode = signedIn ? 0 : 1;
      break;
    }
    if (sub === 'login' && action === '--claudeai') {
      console.log('Opening browser to sign in...');
      console.log('If it did not open, visit https://example.invalid/login');
      if (mode === 'authcli') writeFileSync(stateFile, 'ok');
    }
    break;
  }
  case 'echo':
    // Report what the process received so tests can assert on it.
    out({ type: 'echo', stdin, flags, envKeys: Object.keys(process.env), cwd: process.cwd() });
    break;
  case 'claude-ok':
    out({ type: 'system', subtype: 'init', session_id: 'sess-1' });
    out({ type: 'assistant', message: { content: [{ type: 'text', text: 'Hello ' + stdin.trim() }] } });
    out({ type: 'result', subtype: 'success', is_error: false, result: 'Hello ' + stdin.trim(), total_cost_usd: 0.01, usage: { input_tokens: 3, output_tokens: 4 } });
    break;
  case 'banner-noise':
    process.stdout.write('Welcome to the CLI!\n');
    out({ type: 'system', subtype: 'init', session_id: 's' });
    process.stdout.write('{not json\n');
    out({ type: 'result', subtype: 'success', is_error: false, result: 'ok', usage: {} });
    break;
  case 'fail':
    process.stderr.write('auth expired: please log in again\n');
    process.exit(3);
    break;
  case 'hang':
    out({ type: 'system', subtype: 'init', session_id: 'h' });
    setInterval(() => {}, 1000);
    break;
  case 'no-result':
    out({ type: 'system', subtype: 'init', session_id: 'n' });
    break;
}
