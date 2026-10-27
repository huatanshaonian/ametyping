// Stand-in for Claude Code in the Windows headless test (win-headless-e2e.js): started as "claude.exe" (node under that
// name) in a console window of its own, in the folder it is given. Writes its pid, shows a mark on its screen, records
// what is typed into it (raw mode, UTF-8), and exits after 60 s.
const fs = require('fs'), path = require('path');
const dir = process.cwd();
fs.writeFileSync(path.join(dir, 'target.pid'), String(process.pid));
fs.writeFileSync(path.join(dir, 'target-in.log'), '');
process.stdout.write('AME-HEADLESS-TARGET READY\n');
process.stdin.setRawMode(true);
process.stdin.on('data', (b) => fs.appendFileSync(path.join(dir, 'target-in.log'), b.toString('utf8')));
setTimeout(() => process.exit(0), 60000);
