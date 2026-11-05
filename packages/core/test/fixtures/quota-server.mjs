import readline from 'node:readline';
const mode = process.argv[2];
let initialized = false;
const reply = (value) => process.stdout.write(JSON.stringify(value) + '\n');
readline.createInterface({ input: process.stdin }).on('line', (line) => {
  const message = JSON.parse(line);
  if (mode === 'timeout') return;
  if (message.method === 'initialize') reply({ id: message.id, result: { userAgent: 'fake' } });
  else if (message.method === 'initialized') initialized = true;
  else if (message.method === 'account/rateLimits/read' && initialized) {
    if (mode === 'error') reply({ id: message.id, error: { code: -1, message: 'private credentials must not escape' } });
    else reply({ id: message.id, result: { rateLimits: { primary: { usedPercent: 25, windowDurationMins: 300, resetsAt: 1900000000 }, secondary: { usedPercent: 50, windowDurationMins: 10080 } } } });
  } else reply({ id: message.id, error: { code: -1, message: 'Unexpected method or handshake' } });
});
