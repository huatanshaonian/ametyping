// real launch through the pet's control API on this machine; waits for the new session to answer
const http = require('http'), fs = require('fs'), os = require('os'), path = require('path');
const T = fs.readFileSync(path.join(os.homedir(), '.ametyping', 'control-token-3940'), 'utf8').trim();
const call = (method, p, body) => new Promise((resolve) => {
  const data = body ? JSON.stringify(body) : '';
  const req = http.request({ host: '127.0.0.1', port: 3940, method, path: p, headers: { 'X-Ame-Control': T, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } },
    (res) => { let b = ''; res.on('data', (c) => b += c); res.on('end', () => { try { resolve(JSON.parse(b)); } catch { resolve({ raw: b }); } }); });
  req.on('error', (e) => resolve({ err: e.message })); req.end(data);
});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
(async () => {
  console.log('launch:', JSON.stringify(await call('POST', '/control/launch', { cwd: 'D:\\ame-launchtest', prompt: 'reply with just: launched ok' })));
  let s = null;
  for (let i = 0; i < 50; i++) {
    await sleep(3000);
    const st = await call('GET', '/control/state');
    s = (st.sessions || []).find((x) => x.project === 'ame-launchtest');
    if (s && s.state === 'done') break;
  }
  console.log('session:', JSON.stringify(s && { id: s.id, state: s.state, via: s.via, last: (s.lines.slice(-1)[0] || {}).text }));
  if (s) console.log('exit it:', JSON.stringify(await call('POST', '/control/send', { id: s.id, text: '/exit' })));
})();
