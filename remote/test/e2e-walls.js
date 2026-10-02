// walls.js: address guard, sniffing, and refusals (no network needed for these)
const fs = require('fs'), os = require('os'), path = require('path');
const { createWalls, blocked, sniff } = require(process.argv[2] || require('path').resolve(__dirname, '../server/walls.js'));
let pass = 0, fail = 0;
const ok = (n, c, x = '') => { c ? pass++ : fail++; console.log(`${c ? 'PASS' : 'FAIL'} ${n}${c ? '' : ' ' + x}`); };
for (const ip of ['127.0.0.1', '10.1.2.3', '192.168.1.6', '172.16.0.1', '172.31.255.1', '169.254.1.1', '100.100.10.10', '100.64.0.1', '0.0.0.0', '224.0.0.1', '::1', '::', 'fd7a:115c:a1e0::1', 'fe80::1', '::ffff:127.0.0.1', '::ffff:192.168.1.1'])
  ok(`blocked ${ip}`, blocked(ip) === true);
for (const ip of ['8.8.8.8', '1.1.1.1', '100.63.0.1', '100.128.0.1', '172.32.0.1', '2606:4700::1111'])
  ok(`allowed ${ip}`, blocked(ip) === false);
ok('sniff png', sniff(Buffer.from('89504e470d0a1a0a', 'hex')) === 'png');
ok('sniff jpg', sniff(Buffer.from('ffd8ffe0', 'hex')) === 'jpg');
ok('sniff webp', sniff(Buffer.from('RIFF\0\0\0\0WEBPVP8 ', 'latin1')) === 'webp');
ok('sniff html is not an image', sniff(Buffer.from('<html>')) === null);

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'walls-'));
const w = createWalls(dir);
const refuse = async (url, why) => { try { await w.fetchUrl(url); ok(`refuse ${url}`, false, 'was accepted'); } catch (e) { ok(`refuse ${url} (${e.message})`, !why || e.message.includes(why), e.message); } };
(async () => {
  await refuse('http://example.com/a.png', 'https');
  await refuse('https://127.0.0.1/a.png', '内网');
  await refuse('https://192.168.1.6:5001/a.png', '内网');
  await refuse('https://100.100.10.10/a.png', '内网');
  await refuse('https://localhost/a.png', '内网');
  await refuse('https://[::1]/a.png', '内网');
  await refuse('https://user:pw@example.com/a.png', '账号');
  await refuse('not a url', '格式');
  ok('path traversal names rejected', w.file('../config.json') === null && w.remove('../config.json') === false);
  ok('list empty', w.list().length === 0);
  fs.rmSync(dir, { recursive: true, force: true });
  if (process.argv[3]) {                       // on the NAS: a real public image
    const d2 = fs.mkdtempSync(path.join(os.tmpdir(), 'walls-'));
    const w2 = createWalls(d2);
    try { const n = await w2.fetchUrl(process.argv[3]); ok(`download ${n}`, /\.(png|jpg|webp|gif)$/.test(n) && w2.list().length === 1); }
    catch (e) { ok('download public image', false, e.message); }
    try { await w2.fetchUrl('https://example.com/'); ok('refuse html page', false); } catch (e) { ok(`refuse html page (${e.message})`, true); }
    fs.rmSync(d2, { recursive: true, force: true });
  }
  console.log(`\n${pass} passed, ${fail} failed`);
})();
