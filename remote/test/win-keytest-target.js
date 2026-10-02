// runs in its own console window: records every key sequence it receives (raw mode), exits after 8 s
const fs = require('fs');
const out = process.argv[2];
fs.writeFileSync(out, '');
process.stdin.setRawMode(true);
process.stdin.on('data', (b) => fs.appendFileSync(out, JSON.stringify(b.toString('latin1')) + '\n'));
setTimeout(() => process.exit(0), 8000);
