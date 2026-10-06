// UI check (色调 / 自动切换 / 夜灯: js/shade.js, js/shade-ui.js, css/theme-shades.css), through 显示属性 as you would:
//   - nothing chosen: both looks exactly as before (white surfaces, the same own-message colours);
//   - Windows 标准: 沙漠 and 豆沙绿 recolour every white surface -- the list on the left too -- and keep the grey frame;
//     on 沙漠 your own messages turn pale blue (the tooltip yellow would vanish on parchment), on 豆沙绿 they stay yellow;
//   - Windose: 深夜 and 梅子 are dark, the text light, filled buttons keep white text;
//   - each look has its own shades and remembers its own choice;
//   - 自动切换: 关闭 by default; 固定时间 and 按日出日落 put the night's shade on when it is night; the rows shown follow;
//   - 夜灯: the whole page filtered, by its strength; 只在夜间 offered with 自动切换 only;
//   - a reload: the shade and the night light are on the page before its scripts run.
// Shots in test/out/shots/9x-shade-*.png.
const fs = require('fs'), path = require('path'), os = require('os'), http = require('http'), cp = require('child_process');
const R = path.resolve(__dirname, '..');
const WebSocket = require(R + '/node_modules/ws');
const auth = require(R + '/server/auth');
const OUT = path.join(__dirname, 'out', 'shots'); fs.mkdirSync(OUT, { recursive: true });
const T = fs.mkdtempSync(path.join(os.tmpdir(), 'ame-uishade-'));
const PORT = 18895, CDP = 9359;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const CFG = path.join(T, 'srv', 'config.json'); fs.mkdirSync(path.dirname(CFG));
const env = { ...process.env, AME_REMOTE_CONFIG: CFG, AME_SUMMARY_TICK_MS: '600000' };
cp.execFileSync(process.execPath, [R + '/server/setup.js', 'init'], { env: { ...env, AME_USER: 'u', AME_PASSWORD: 'pw-123456789012' } });
const cfg = JSON.parse(fs.readFileSync(CFG)); cfg.web.port = PORT; cfg.summary = { enabled: false };
fs.writeFileSync(CFG, JSON.stringify(cfg));

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
    let id = 0; const pending = new Map();
    ws.on('message', (m) => {
      const o = JSON.parse(m);
      if (o.id && pending.has(o.id)) { pending.get(o.id)(o); pending.delete(o.id); }
      if (o.method === 'Runtime.exceptionThrown') errors.push('exception: ' + JSON.stringify(o.params.exceptionDetails.exception && o.params.exceptionDetails.exception.description || o.params.exceptionDetails.text).slice(0, 300));
      if (o.method === 'Runtime.consoleAPICalled' && o.params.type === 'error') errors.push('console: ' + o.params.args.map((a) => a.value || a.description).join(' ').slice(0, 300));
    });
    const call = (method, params = {}) => new Promise((r) => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
    const evalJs = async (expr) => (await call('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true })).result.result.value;
    const shot = async (name) => { const r = await call('Page.captureScreenshot', { format: 'png' }); fs.writeFileSync(path.join(OUT, name), Buffer.from(r.result.data, 'base64')); };
    await call('Runtime.enable'); await call('Page.enable'); await call('Network.enable');
    await call('Network.setCookie', { name: cname, value: cval, url: `http://127.0.0.1:${PORT}/` });
    await call('Emulation.setDeviceMetricsOverride', { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
    await call('Page.navigate', { url: `http://127.0.0.1:${PORT}/` });
    await sleep(3500);

    // what the page looks like, measured: the side of 糖糖看板 with its list, the page of a window, one of your own
    // messages (a stand-in put into the conversation), a filled button's text, the frame's grey, the filter
    const look = () => evalJs(`(() => {
      const cs = (el, p) => el ? getComputedStyle(el)[p] : null;
      const conv = document.querySelector('.dash .conv'); let me = conv.querySelector('.m.user.__probe');
      if (!me) { me = document.createElement('div'); me.className = 'm user __probe'; me.textContent = '我说的话'; conv.append(me); }
      let go = document.querySelector('.__go'); if (!go) { go = document.createElement('button'); go.className = 'btn go __go'; go.style.cssText = 'position:fixed;left:-99px'; document.body.append(go); }
      const html = document.documentElement;
      return { shade: html.dataset.shade || '', theme: html.dataset.theme || '', nl: html.dataset.nl || '', nlv: html.style.getPropertyValue('--nl'), filter: cs(html, 'filter'),
        list: cs(document.querySelector('.dash .side'), 'backgroundColor'), page: cs(document.querySelector('.win .content'), 'backgroundColor'), ink: cs(document.body, 'color'),
        mine: cs(me, 'backgroundColor'), goText: cs(go, 'color'), goBg: cs(go, 'backgroundColor'), taskbar: cs(document.querySelector('#taskbar'), 'backgroundColor') };
    })()`);
    const lum = (rgb) => { const m = /(\d+), (\d+), (\d+)/.exec(rgb || ''); return m ? (0.299 * m[1] + 0.587 * m[2] + 0.114 * m[3]) : -1; };
    const pick = async (sel, value) => { await evalJs(`(() => { const s = document.querySelector(${JSON.stringify(sel)}); s.value = ${JSON.stringify(value)}; s.dispatchEvent(new Event(s.type === 'range' ? 'input' : 'change')); })()`); await sleep(350); };
    const opts = (sel) => evalJs(`[...(document.querySelector(${JSON.stringify(sel)}) || { options: [] }).options].map(o => o.textContent).join('|')`);
    const has = (sel) => evalJs(`!!document.querySelector(${JSON.stringify(sel)})`);

    // nothing chosen: as it always was
    let v = await look();
    const light = v;
    chk('nothing chosen: no shade, no night light; the colours it always had', v.shade === '' && v.nl === '' && v.filter === 'none' && v.list === 'rgba(240, 209, 241, 0.32)' && v.page === 'rgb(255, 248, 255)' && v.mine === 'rgb(240, 209, 241)' && v.goText === 'rgb(255, 255, 255)', v);
    await evalJs("[...document.querySelectorAll('.dicon')].find(b => b.textContent.includes('控制面板')).dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))"); await sleep(1500);
    chk('显示属性: 色调 with this look\'s shades, 自动切换 关闭, 夜灯 关闭; nothing about nights shown', (await opts('#sh-day')) === '浅色（原样）|深夜|梅子' && (await opts('#sh-auto')) === '关闭|按日出日落|固定时间' &&
      (await evalJs("document.querySelector('#sh-auto').value")) === 'off' && (await opts('#sh-light')) === '关闭|一直开' && !(await has('#sh-night')) && !(await has('#sh-level')), [await opts('#sh-day'), await opts('#sh-auto'), await opts('#sh-light')]);

    // Windose: 深夜, 梅子
    await pick('#sh-day', 'night'); v = await look();
    chk('深夜: dark surfaces (the list too), light text, a filled button still white on its fill', v.shade === 'night' && v.list !== light.list && lum(v.page) < 70 && lum(v.ink) > 200 && v.goText === 'rgb(255, 255, 255)' && lum(v.goBg) < 140 && lum(v.mine) < 110, v);
    await shot('90-shade-night.png');
    await pick('#sh-day', 'plum'); const p = await look();
    chk('梅子: dark too, another colour', p.shade === 'plum' && lum(p.page) < 80 && p.page !== v.page && p.list !== v.list && lum(p.ink) > 200, p);

    // Windows 标准 has shades of its own and its own choice
    await evalJs("(() => { const s = document.querySelector('.wallbar select[title=配色方案]'); s.value = 'win98'; s.dispatchEvent(new Event('change')); })()"); await sleep(600);
    v = await look();
    chk('Windows 标准: its own shades offered, none chosen yet -- white as before, your messages the tooltip yellow', (await opts('#sh-day')) === '标准（白底）|沙漠|豆沙绿' && v.theme === 'win98' && v.shade === '' &&
      v.list === 'rgb(255, 255, 255)' && v.page === 'rgb(255, 255, 255)' && v.mine === 'rgb(255, 255, 225)' && v.taskbar === 'rgb(192, 192, 192)', [await opts('#sh-day'), v]);
    await pick('#sh-day', 'desert'); v = await look();
    chk('沙漠: every white surface parchment -- the list on the left too -- the grey frame kept; your messages pale blue', v.shade === 'desert' && v.list === 'rgb(240, 229, 203)' && v.page === 'rgb(236, 223, 194)' &&
      v.mine === 'rgb(211, 224, 239)' && v.taskbar === 'rgb(192, 192, 192)' && v.ink === 'rgb(0, 0, 0)', v);
    await shot('91-shade-desert.png');
    await pick('#sh-day', 'green'); v = await look();
    chk('豆沙绿: green surfaces, your messages stay yellow', v.shade === 'green' && v.list === 'rgb(215, 235, 215)' && v.page === 'rgb(207, 230, 207)' && v.mine === 'rgb(255, 255, 225)' && v.taskbar === 'rgb(192, 192, 192)', v);
    await evalJs("(() => { const s = document.querySelector('.wallbar select[title=配色方案]'); s.value = 'windose'; s.dispatchEvent(new Event('change')); })()"); await sleep(600);
    v = await look();
    chk('back to Windose: its own choice (梅子) again, not the other look\'s', v.theme === '' && v.shade === 'plum' && (await evalJs("document.querySelector('#sh-day').value")) === 'plum', v);
    await pick('#sh-day', '');

    // 自动切换: 固定时间 -- an hour around now is "night"
    const hm = (d) => String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
    const now = Date.now();
    await pick('#sh-auto', 'clock');
    chk('固定时间: the night\'s shade and its hours are shown (19:00 到 07:00 at first), 夜灯 may follow the night', (await has('#sh-night')) && (await evalJs("document.querySelector('#sh-from').value + '-' + document.querySelector('#sh-to').value")) === '19:00-07:00' &&
      (await evalJs("document.querySelector('#sh-night').value")) === 'night' && (await opts('#sh-light')) === '关闭|一直开|只在夜间', [await opts('#sh-light')]);
    await pick('#sh-from', hm(new Date(now - 3600e3))); await pick('#sh-to', hm(new Date(now + 3600e3)));
    v = await look();
    chk('it is night by those hours: the night\'s shade (深夜) is on, the window says so', v.shade === 'night' && /现在是夜间/.test(await evalJs("document.querySelector('.shadebar').textContent")), [v.shade, await evalJs("document.querySelector('.shadebar').textContent")]);
    await pick('#sh-night', 'plum'); chk('another shade for the night', (await look()).shade === 'plum', await look());
    await pick('#sh-from', hm(new Date(now + 3600e3))); await pick('#sh-to', hm(new Date(now + 7200e3)));
    v = await look();
    chk('it is day by those hours: the day\'s shade (none) again', v.shade === '' && /现在是白天/.test(await evalJs("document.querySelector('.shadebar').textContent")), v.shade);
    // 夜灯 只在夜间: off by day, on by night
    await pick('#sh-light', 'night'); v = await look();
    chk('夜灯 只在夜间, by day: not on', v.nl === '' && v.filter === 'none', v);
    await pick('#sh-from', hm(new Date(now - 3600e3))); await pick('#sh-to', hm(new Date(now + 3600e3))); v = await look();
    chk('... by night: on, with the night\'s shade', v.nl === '1' && /sepia/.test(v.filter) && v.shade === 'plum', v);

    // 按日出日落: a place, today's sunrise and sunset, and whether it is night there now
    await pick('#sh-auto', 'sun');
    const sun = await evalJs("document.querySelector('#sh-sun').textContent");
    chk('按日出日落: a city (北京 at first), today\'s sunrise and sunset there, day or night now', (await evalJs("document.querySelector('#sh-city').value")) === '北京' && /今天日出 0\d:\d\d，日落 1\d:\d\d/.test(sun) && /现在是(夜间|白天)/.test(sun) && !(await has('#sh-lat')), sun);
    const nightThere = /现在是夜间/.test(sun);
    chk('the shade follows the sun there', (await look()).shade === (nightThere ? 'plum' : ''), [(await look()).shade, sun]);
    await pick('#sh-city', '纽约');
    const sun2 = await evalJs("document.querySelector('#sh-sun').textContent");
    chk('another city: its own times (half a day away: day and night the other way round, or nearly)', sun2 !== sun && /今天日出/.test(sun2), [sun, sun2]);
    await pick('#sh-city', '');
    chk('自己填经纬度: the two fields', (await has('#sh-lat')) && (await has('#sh-lon')), 0);
    await pick('#sh-lat', '89'); await pick('#sh-lon', '15');                 // (only around the equinoxes does the sun rise and set there)
    chk('far north: the sun does not rise or does not set today, said so', /今天太阳不(升起|落下)/.test(await evalJs("document.querySelector('#sh-sun').textContent")), await evalJs("document.querySelector('#sh-sun').textContent"));

    // 关闭 again: the day's shade whatever the hour; 夜灯 on its own, by its strength
    await pick('#sh-auto', 'off'); v = await look();
    chk('自动切换 关闭: the day\'s shade, no night rows; 夜灯 只在夜间 has no night to follow', v.shade === '' && v.nl === '' && !(await has('#sh-night')) && /自动切换是关闭的/.test(await evalJs("document.querySelector('.shadebar').textContent")), v);
    await pick('#sh-light', 'on'); v = await look();
    chk('夜灯 一直开: the whole page warmed and dimmed, at half strength', v.nl === '1' && v.nlv === '0.5' && /sepia\(0\.27\d*\)/.test(v.filter) && /brightness\(0\.93\d*\)/.test(v.filter) && (await has('#sh-level')), v);
    await pick('#sh-level', '100'); const strong = await look();
    await pick('#sh-level', '20'); const weak = await look();
    chk('its strength: stronger and weaker', strong.nlv === '1' && /sepia\(0\.55\)/.test(strong.filter) && weak.nlv === '0.2' && /sepia\(0\.11\)/.test(weak.filter), [strong.filter, weak.filter]);
    await shot('92-shade-nightlight.png');
    chk('the windows still sit where they were under the filter (fixed parts not displaced)', await evalJs("(() => { const t = document.querySelector('#taskbar').getBoundingClientRect(); return Math.abs(t.bottom - innerHeight / (parseFloat(document.documentElement.style.zoom) || 1)) < 3 || Math.abs(t.bottom - document.documentElement.clientHeight) < 3; })()"), 0);

    // a reload: on the page before its scripts run
    await pick('#sh-day', 'night');
    await call('Page.addScriptToEvaluateOnNewDocument', { source: "document.addEventListener('readystatechange', () => { if (!window.__early) window.__early = { shade: document.documentElement.dataset.shade || '', nl: document.documentElement.dataset.nl || '', modules: !!document.querySelector('.dicon') }; });" });
    await call('Page.reload'); await sleep(3500);
    const early = await evalJs('window.__early'); v = await look();
    chk('after a reload: the shade and the night light are there before the page\'s scripts ran, and stay', early && early.shade === 'night' && early.nl === '1' && early.modules === false && v.shade === 'night' && v.nl === '1' && v.nlv === '0.2', [early, v]);
    ws.close();
  } catch (e) { errors.push('test: ' + e.stack); }
  finally { try { chrome && chrome.kill(); } catch {} srv.kill(); }
  for (const r of res) console.log(r);
  console.log(errors.length ? 'page errors:\n' + errors.join('\n') : 'no page errors');
  await sleep(800);
  try { fs.rmSync(T, { recursive: true, force: true }); } catch {}
  process.exit(res.some((r) => r.startsWith('FAIL')) || errors.length ? 1 : 0);
})();
