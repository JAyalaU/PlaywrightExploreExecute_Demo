// Ubuntu's pinned noVNC 1.3.0 package has the raw-decoder offset bug fixed
// upstream in 1.4.0. Apply only that reviewed correction to the copied assets.
const fs = require('node:fs');

const path = '/opt/public-browser/novnc/core/decoders/raw.js';
const before = fs.readFileSync(path, 'utf8');
const oldLine = '            data[i * 4 + 3] = 255;';
const fixedLine = '            data[index + i * 4 + 3] = 255;';
const matches = before.split(oldLine).length - 1;
if (matches !== 1 || before.includes(fixedLine)) {
  throw new Error('Pinned noVNC raw decoder differs from reviewed 1.3.0 source');
}
fs.writeFileSync(path, before.replace(oldLine, fixedLine));
