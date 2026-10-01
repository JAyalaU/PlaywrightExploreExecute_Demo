// Windows process-group fixture for the Python host cancellation tests.
const fs = require('node:fs');

const marker = process.env.HOST_CANCEL_MARKER;
const mode = process.env.HOST_CANCEL_MODE;
if (!marker || !['graceful', 'ignore'].includes(mode)) process.exit(2);

process.on('SIGBREAK', () => {
  if (mode === 'ignore') return;
  fs.writeFileSync(`${marker}.cleaned`, 'closed');
  setTimeout(() => process.exit(0), 50);
});
fs.writeFileSync(`${marker}.ready`, 'ready');
setInterval(() => undefined, 1000);
