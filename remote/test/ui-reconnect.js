// UI check (the page's connection, public/js/net.js): what a phone does to a page in the background -- the socket
// dies without the page being told. Chrome talks to the server through a relay here that can go silent on the
// connections it has (nothing forwarded, nothing closed) while new ones still get through:
//   - a dead socket nobody reported: back on screen (visibilitychange) the page pings, gets no answer within 4 s and
//     replaces the socket; data flows again;
//   - a socket closed outright: connected again within a couple of seconds;
//   - a healthy socket: the ping is answered, nothing is replaced.
const fs = require('fs'), path = require('path'), os = require('os'), http = require('http'), net = require('net'), cp = require('child_process');
const R = path.resolve(__dirname, '..');
const WebSocket = require(R + '/node_modules/ws');
const auth = require(R + '/server/auth');
const T = fs.mkdtempSync(path.join(os.tmpdir(), 'ame-uirec-'));
const PORT = 18897, RELAY = 18898, CDP = 9357;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const CFG = path.join(T, 'srv', 'config.json'); fs.mkdirSync(path.dirname(CFG));
const env = { ...process.env, AME_REMOTE_CONFIG: CFG, AME_SUMMARY_TICK_MS: '600000' };
cp.execFileSync(process.execPath, [R + '/server/setup.js', 'init'], { env: { ...env, AME_USER: 'u', AME_PASSWORD: 'pw-123456789012' } });
const cfg = JSON.parse(fs.readFileSync(CFG)); cfg.web.port = PORT; cfg.summary = { enabled: false };
fs.writeFileSync(CFG, JSON.stringify(cfg));

// the relay: every connection piped to the server; freeze() makes the ones open now go silent, kill() closes them
const pairs = new Set(); let conns = 0;
const relay = net.createServer((a) => {
  conns++;
  const b = net.connect(PORT, '127.0.0.1'), p = { a, b, frozen: false };
  pairs.add(p);
  a.on('data', (d) => { if (!p.frozen) b.write(d); }); b.on('data', (d) => { if (!p.frozen) a.write(d); });
  const end = () => { pairs.delete(p); a.destroy(); b.destroy(); };
  a.on('close', end); b.on('close', end); a.on('error', end); b.on('error', end);
}).listen(RELAY, '127.0.0.1');
const freeze = () => { for (const p of pairs) p.frozen = true; };
const kill = () => { for (const p of [...pairs]) { p.a.destroy(); p.b.destroy(); } };

const getJSON = (url, method = 'GET') => new Promise((resolve, reject) => { const r = http.request(url, { method }, (res) => { let b = ''; res.on('data', (c) => b += c); res.on('end', () => { try { resolve(JSON.parse(b)); } catch (e) { reject(e); } }); }); r.on('error', reject); r.end(); });
function login() {
  return new Promise((resolve) => {
    const body = JSON.stringify({ user: 'u', password: 'pw-123456789012', code: auth.totpAt(JSON.parse(fs.readFileSync(CFG)).totpSecret, Math.floor(Date.now() / 30000)) });
    const req = http.request({ host: '127.0.0.1', port: PORT, path: '/api/login', method: 'POST', headers: { 'Content-Type': 'application/json', Origin: `http://127.0.0.1:${PORT}`, 'Content-Length': Buffer.byteLength(body) } },
      (res) => { res.resume(); resolve(String(res.headers['set-cookie'] || '').split(';')[0].split('=')); });
    req.end(body);
  });
}

(async () => {
  const errors = [], res = [];
  const chk = (n, c, x) => res.push((c ? 'PASS ' : 'FAIL ') + n + (c ? '' : ' ' + JSON.stringify(x)));
  const srv = cp.spawn(process.execPath, [R + '/server/server.js'], { env, stdio: 'ignore' });
  let chrome;
  try {
    await sleep(2500);
    const [cname, cval] = await login();
    chrome = cp.spawn(process.env.CHROME || 'C:/Program Files/Google/Chrome/Application/chrome.exe', ['--headless=new', '--disable-gpu', `--remote-debugging-port=${CDP}`,
      `--user-data-dir=${path.join(T, 'chrome')}`, '--no-first-run', '--no-proxy-server', 'about:blank'], { stdio: 'ignore' });
    await sleep(2000);
    const tab = await getJSON(`http://127.0.0.1:${CDP}/json/new?about:blank`, 'PUT');
    const ws = new WebSocket(tab.webSocketDebuggerUrl); await new Promise((r) => ws.on('open', r));
    let id = 0; const pending = new Map(); const sockets = [];        // the page's WebSockets, as Chrome opens them
    ws.on('message', (m) => {
      const o = JSON.parse(m);
      if (o.id && pending.has(o.id)) { pending.get(o.id)(o); pending.delete(o.id); }
      if (o.method === 'Network.webSocketCreated' && /\/ws$/.test(o.params.url)) sockets.push(o.params.requestId);
      if (o.method === 'Runtime.exceptionThrown') errors.push('exception: ' + JSON.stringify(o.params.exceptionDetails.exception && o.params.exceptionDetails.exception.description || o.params.exceptionDetails.text).slice(0, 300));
    });
    const call = (method, params = {}) => new Promise((r) => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
    const evalJs = async (expr) => (await call('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true })).result.result.value;
    await call('Runtime.enable'); await call('Page.enable'); await call('Network.enable');
    await call('Network.setCookie', { name: cname, value: cval, url: `http://127.0.0.1:${RELAY}/` });
    await call('Page.navigate', { url: `http://127.0.0.1:${RELAY}/` });
    await sleep(3500);
    // what the page knows: connected or not, how many times it (re)connected, when it last heard the session list
    await evalJs("import('/js/net.js').then(n => { window.__n = n; window.__opens = 0; window.__lists = 0; n.on('open', () => window.__opens++); n.on('sessions', () => window.__lists++); })");
    const st = () => evalJs("({ online: window.__n.state.online, opens: window.__opens, lists: window.__lists, tray: (document.querySelector('#taskbar .conn, .conn') || {}).textContent })");
    const back = () => evalJs("document.dispatchEvent(new Event('visibilitychange'))");
    chk('connected through the relay', (await st()).online && sockets.length === 1, [await st(), sockets.length]);

    // a healthy socket checked: answered, kept
    await back(); await sleep(5000);
    chk('a healthy socket: the check is answered, nothing replaced', (await st()).online && sockets.length === 1 && (await st()).opens === 0, [await st(), sockets.length]);

    // the socket dies without a word (the phone froze the page): the page still believes in it
    freeze(); await sleep(1500);
    chk('a socket gone silent: the page has not been told', (await st()).online === true && sockets.length === 1, await st());
    // back on screen: checked, no answer within 4 s, replaced; the session list comes in again
    const t0 = Date.now();
    await back();
    let s = {}; for (let i = 0; i < 40; i++) { await sleep(250); s = await st(); if (s.opens >= 1 && s.online) break; }
    const took = Date.now() - t0;
    chk('back on screen: the dead socket found out and replaced within a few seconds', s.online && s.opens === 1 && sockets.length === 2 && took < 7000, [s, sockets.length, took]);
    chk('data flows again (the session list arrived on the new socket)', s.lists >= 1, s);

    // a socket closed outright: connected again by itself
    const o1 = s.opens;
    kill();
    for (let i = 0; i < 24; i++) { await sleep(250); s = await st(); if (s.opens > o1 && s.online) break; }
    chk('a socket closed: connected again within a few seconds, by itself', s.online && s.opens === o1 + 1 && sockets.length === 3, [s, sockets.length]);

    // a phone's background: the page hidden for a while, its socket dead meanwhile. Back on screen it is not even
    // asked (that would cost the 4 s): a new socket at once, and the page never showed "disconnected"
    await evalJs("(() => { window.__hid = true; Object.defineProperty(document, 'hidden', { get: () => window.__hid, configurable: true }); window.__downs = 0; window.__n.on('status', (up) => { if (!up) window.__downs++; }); document.dispatchEvent(new Event('visibilitychange')); })()");
    freeze(); await sleep(6000);
    const o3 = (await st()).opens, n3 = sockets.length, t3 = Date.now();
    await evalJs("(() => { window.__hid = false; document.dispatchEvent(new Event('visibilitychange')); })()");
    for (let i = 0; i < 30; i++) { await sleep(100); s = await st(); if (s.opens > o3 && s.online) break; }
    const took3 = Date.now() - t3;
    chk('back from 6 s out of sight with a dead socket: a new one at once (well under the 4 s of asking), never shown as disconnected', s.online && s.opens === o3 + 1 && sockets.length === n3 + 1 && took3 < 2000 &&
      (await evalJs('window.__downs')) === 0, [s, sockets.length - n3, took3, await evalJs('window.__downs')]);
    await evalJs("delete document.hidden");

    // the connection mark in the tray: a click connects again at once, whatever the socket looks like
    const o4 = (await st()).opens, n4 = sockets.length;
    chk('the connection mark can be clicked', await evalJs("(() => { const c = document.querySelector('#conn'); return c.getAttribute('role') === 'button' && getComputedStyle(c).cursor === 'pointer' && /重新连接/.test(c.title); })()"), await evalJs("document.querySelector('#conn').title"));
    await evalJs("document.querySelector('#conn').click()");
    for (let i = 0; i < 30; i++) { await sleep(100); s = await st(); if (s.opens > o4 && s.online) break; }
    chk('a click on it: a new socket, connected again', s.online && s.opens === o4 + 1 && sockets.length === n4 + 1, [s, sockets.length - n4]);

    // the server away for a while (the tries slow down), then back: coming back on screen connects at once
    for (const p of [...pairs]) p.frozen = true;
    relay.close(); kill();
    await sleep(9000);
    chk('the server unreachable: the page says so', (await st()).online === false, await st());
    await new Promise((r) => relay.listen(RELAY, '127.0.0.1', r));
    const t1 = Date.now(), o2 = (await st()).opens;
    await back();
    for (let i = 0; i < 20; i++) { await sleep(150); s = await st(); if (s.opens > o2 && s.online) break; }
    chk('reachable again and back on screen: connected at once, not at the next slow retry', s.online && Date.now() - t1 < 2500, [s, Date.now() - t1]);
    ws.close();
  } catch (e) { errors.push('test: ' + e.stack); }
  finally { try { chrome && chrome.kill(); } catch {} srv.kill(); try { relay.close(); } catch {} kill(); }
  for (const r of res) console.log(r);
  console.log(errors.length ? 'page errors:\n' + errors.join('\n') : 'no page errors');
  await sleep(800);
  try { fs.rmSync(T, { recursive: true, force: true }); } catch {}
  process.exit(res.some((r) => r.startsWith('FAIL')) || errors.length ? 1 : 0);
})();
