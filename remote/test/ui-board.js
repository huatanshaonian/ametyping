// UI check: 画板 in headless Chrome (a throwaway server, the fake Codex as the model). Drawn with a pen (pressure),
// a mouse and fingers through the browser's own input; then erased, undone, picked and dragged, moved and zoomed; saved and read back;
// given to the model and shown again as 还原稿 / 文字档 / 设计稿; exported. Screenshots in test/out/shots.
const fs = require('fs'), path = require('path'), os = require('os'), http = require('http'), cp = require('child_process');
const R = path.resolve(__dirname, '..');
const WebSocket = require(R + '/node_modules/ws');
const auth = require(R + '/server/auth');
const OUT = path.join(__dirname, 'out', 'shots'); fs.mkdirSync(OUT, { recursive: true });
const T = fs.mkdtempSync(path.join(os.tmpdir(), 'ame-uiboard-'));
const CFG = path.join(T, 'srv', 'config.json'); fs.mkdirSync(path.dirname(CFG));
const PORT = 18847, CDP = 9347;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0, fail = 0;
const ok = (n, c, x = '') => { c ? pass++ : fail++; console.log(`${c ? 'PASS' : 'FAIL'} ${n}${c ? '' : ' ' + (typeof x === 'string' ? x : JSON.stringify(x)).slice(0, 700)}`); };
const env = { ...process.env, AME_REMOTE_CONFIG: CFG };
cp.execFileSync(process.execPath, [R + '/server/setup.js', 'init'], { env: { ...env, AME_USER: 'u', AME_PASSWORD: 'pw-123456789012' } });
const cfg = JSON.parse(fs.readFileSync(CFG)); cfg.web.port = PORT;
cfg.summary = { proxies: [], codex: [process.execPath, path.join(__dirname, 'fake-codex.js')] };
fs.writeFileSync(CFG, JSON.stringify(cfg));
const kids = [];
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
  const errors = [];
  let chrome;
  try {
    kids.push(cp.spawn(process.execPath, [R + '/server/server.js'], { env, stdio: 'ignore' })); await sleep(2500);
    const [cname, cval] = await login();
    chrome = cp.spawn(process.env.CHROME || 'C:/Program Files/Google/Chrome/Application/chrome.exe', ['--headless=new', '--disable-gpu', `--remote-debugging-port=${CDP}`,
      `--user-data-dir=${path.join(T, 'chrome')}`, '--no-first-run', '--no-proxy-server', 'about:blank'], { stdio: 'ignore' });
    await sleep(2000);
    const tab = await getJSON(`http://127.0.0.1:${CDP}/json/new?about:blank`, 'PUT');
    const ws = new WebSocket(tab.webSocketDebuggerUrl);
    await new Promise((r) => ws.on('open', r));
    let id = 0; const pending = new Map();
    ws.on('message', (m) => {
      const o = JSON.parse(m);
      if (o.id && pending.has(o.id)) { pending.get(o.id)(o); pending.delete(o.id); }
      if (o.method === 'Runtime.exceptionThrown') errors.push('exception: ' + JSON.stringify(o.params.exceptionDetails.exception && o.params.exceptionDetails.exception.description || o.params.exceptionDetails.text).slice(0, 400));
      if (o.method === 'Runtime.consoleAPICalled' && o.params.type === 'error') errors.push('console: ' + o.params.args.map((a) => a.value || a.description).join(' ').slice(0, 400));
      if (o.method === 'Log.entryAdded' && o.params.entry.level === 'error') errors.push('log: ' + o.params.entry.text.slice(0, 400) + ' ' + (o.params.entry.url || ''));
    });
    const call = (method, params = {}) => new Promise((r) => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
    const evalJs = async (expr) => { const r = (await call('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true })).result; if (r.exceptionDetails) throw new Error('eval: ' + JSON.stringify(r.exceptionDetails).slice(0, 400)); return r.result.value; };
    const shot = async (name) => { const r = await call('Page.captureScreenshot', { format: 'png' }); fs.writeFileSync(path.join(OUT, name), Buffer.from(r.result.data, 'base64')); };
    await call('Runtime.enable'); await call('Log.enable'); await call('Page.enable'); await call('Network.enable');
    await call('Network.setCookie', { name: cname, value: cval, url: `http://127.0.0.1:${PORT}/` });
    await call('Emulation.setDeviceMetricsOverride', { width: 1400, height: 900, deviceScaleFactor: 1, mobile: false });
    await call('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: path.join(T, 'dl') });
    await call('Page.navigate', { url: `http://127.0.0.1:${PORT}/` });
    await sleep(3500);

    await evalJs("document.querySelector('.dicon[data-id=board]').dispatchEvent(new MouseEvent('dblclick', {bubbles:true}))"); await sleep(1200);
    const box = await evalJs("(() => { const r = document.querySelector('.bd-surface').getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width, h: r.height }; })()");
    ok('the board opens with a sheet to draw on', box && box.w > 600 && box.h > 300, box);
    const B = (x, y) => ({ x: box.x + x, y: box.y + y });
    // what the app knows, read through the server (the page saves on its own)
    const api = (p) => evalJs(`fetch(${JSON.stringify(p)}).then((r) => r.json())`);
    const strokesOf = async () => { const l = (await api('/api/boards')).items; return l.length ? (await api('/api/board?id=' + l[0].id)).doc.strokes : []; };
    const pointer = async (type, pts, kind = 'mouse', more = {}) => {
      for (let i = 0; i < pts.length; i++) {
        const [x, y, force] = pts[i], p = B(x, y);
        await call('Input.dispatchMouseEvent', { type: i === 0 ? 'mousePressed' : 'mouseMoved', x: p.x, y: p.y, button: more.button || 'left', buttons: more.buttons || 1, clickCount: 1, pointerType: kind, force: force == null ? 0.5 : force });
      }
      const [x, y] = pts[pts.length - 1], p = B(x, y);
      await call('Input.dispatchMouseEvent', { type: 'mouseReleased', x: p.x, y: p.y, button: more.button || 'left', buttons: 0, clickCount: 1, pointerType: kind });
    };
    const line = (x0, y0, x1, y1, n, f = () => 0.5) => Array.from({ length: n + 1 }, (_, i) => [x0 + (x1 - x0) * i / n, y0 + (y1 - y0) * i / n, f(i / n)]);
    // the colour in the middle of a point of the sheet as it is on screen (both canvases blended), from a screenshot
    const { createCanvas, loadImage } = require(R + '/node_modules/@napi-rs/canvas');
    const pixel = async (x, y) => {
      const r = await call('Page.captureScreenshot', { format: 'png' }), img = await loadImage(Buffer.from(r.result.data, 'base64'));
      const c = createCanvas(img.width, img.height), g = c.getContext('2d'); g.drawImage(img, 0, 0);
      const p = B(x, y), d = g.getImageData(Math.round(p.x), Math.round(p.y), 1, 1).data;
      return [d[0], d[1], d[2]];
    };

    // ---- a pen: light at the start, firm at the end
    await pointer('pen', line(80, 80, 480, 80, 40, (t) => 0.1 + 0.9 * t), 'pen'); await sleep(200);
    const light = await pixel(110, 80), dark = await pixel(450, 80), paper = await pixel(300, 200);
    ok('a pen stroke: pressure makes it darker along the way, on white paper', paper.join() === '255,255,255' && light[0] > dark[0] + 40 && dark[0] < 80, [light, dark, paper]);
    await sleep(1800);
    let st = await strokesOf();
    ok('it is saved on its own, with the pressures', st.length === 1 && st[0].t === 'pencil' && st[0].p.length >= 60 && st[0].p[2] < 0.25 && st[0].p[st[0].p.length - 1] > 0.9, st.map((s) => [s.t, s.p.length, s.p[2], s.p[s.p.length - 1]]));
    ok('a pen has been seen: fingers now move the sheet', await evalJs("!document.querySelector('.bd-bar [data-act=finger]').classList.contains('sel')"));

    // ---- a mouse; the marker over it; colours
    await pointer('mouse', line(80, 140, 480, 140, 20)); await sleep(100);
    await evalJs("document.querySelector('.bd-tool[data-tool=marker]').click()");
    await pointer('mouse', line(60, 140, 500, 140, 20)); await sleep(200);
    const under = await pixel(300, 140), mark = await pixel(300, 133);
    ok('the marker goes over the writing and the writing still shows', under[0] < 90 && mark[0] > 200 && mark[2] < 200, [under, mark]);
    await evalJs("document.querySelector('.bd-tool[data-tool=pencil]').click(); document.querySelector('.bd-sw[data-c=\"#d93025\"]').click()");
    await pointer('pen', line(80, 200, 480, 260, 30, () => 0.9), 'pen'); await sleep(200);
    const red = await pixel(280, 230);
    ok('a colour for the pencil', red[0] > 180 && red[1] < 90, red);
    await shot('board-1-drawn.png');

    // ---- eraser, undo, redo
    await evalJs("document.querySelector('.bd-tool[data-tool=eraser]').click()");
    await pointer('mouse', line(280, 190, 280, 270, 10)); await sleep(200);
    ok('the eraser takes the whole stroke it touches', (await pixel(180, 215)).join() === '255,255,255', await pixel(180, 215));
    await evalJs("document.querySelector('.bd-bar [data-act=undo]').click()"); await sleep(150);
    const back = await pixel(280, 230);
    await evalJs("document.querySelector('.bd-bar [data-act=undo]').click()"); await sleep(150);   // (the red stroke itself)
    const gone = await pixel(280, 230);
    await evalJs("document.querySelector('.bd-bar [data-act=redo]').click()"); await sleep(150);
    ok('undo brings it back, undo again takes the stroke away, redo draws it again', back[0] > 180 && back[1] < 90 && gone.join() === '255,255,255' && (await pixel(280, 230))[1] < 90, [back, gone]);
    // the pen's own eraser end (button 5)
    await evalJs("document.querySelector('.bd-tool[data-tool=pencil]').click()");
    // (the browser's test input has no such button: the events are made in the page)
    await evalJs(`(() => { const el = document.querySelector('.bd-surface'), r = el.getBoundingClientRect();
      const ev = (type, y, buttons) => el.dispatchEvent(new PointerEvent(type, { bubbles: true, pointerId: 77, pointerType: 'pen', button: type === 'pointermove' ? -1 : 5, buttons, clientX: r.left + 280, clientY: r.top + y, pressure: buttons ? 0.5 : 0 }));
      ev('pointerdown', 190, 32); for (let y = 195; y <= 270; y += 5) ev('pointermove', y, 32); ev('pointerup', 270, 0); })()`); await sleep(200);
    const penErased = (await pixel(180, 215)).join() === '255,255,255';
    await evalJs("document.querySelector('.board').dispatchEvent(new KeyboardEvent('keydown', { key: 'z', ctrlKey: true, bubbles: true }))"); await sleep(150);
    ok('the eraser end of the pen erases with any tool chosen; Ctrl+Z undoes', penErased && (await pixel(280, 230))[1] < 90);

    // ---- picking: the right button draws a line round strokes (any shape), what is picked is dragged, deleted
    await evalJs("document.querySelector('.bd-tool[data-tool=pencil]').click()");
    const R2 = { button: 'right', buttons: 2 }, selBox = () => evalJs("(() => { const e = document.querySelector('.bd-sel'); if (e.hidden) return null; const r = e.getBoundingClientRect(), s = document.querySelector('.bd-surface').getBoundingClientRect(); return [r.left - s.left, r.top - s.top, r.width, r.height].map(Math.round); })()");
    // a slanted loop round the red stroke only (the lines above it stay outside)
    await pointer('mouse', [[60, 185], [200, 180], [500, 240], [500, 285], [300, 280], [60, 225], [60, 185]], 'mouse', R2); await sleep(200);
    const sb = await selBox();
    ok('a line drawn round the red stroke with the right button picks it, and only it', sb && Math.abs(sb[0] - 76) < 6 && Math.abs(sb[2] - 408) < 10 && sb[1] > 185 && /选中的 1 笔/.test(await evalJs("document.querySelector('.bd-bar [data-act=ai]').title")) &&
      await evalJs("document.querySelector('.bd-bar [data-act=ai]').textContent === 'AI（选中的）'"), sb);
    await pointer('mouse', [[280, 230], [300, 260], [280, 330]], 'mouse', R2); await sleep(250);
    ok('dragged from inside, it goes along (the others stay)', (await pixel(280, 330))[1] < 90 && (await pixel(280, 230)).join() === '255,255,255' && (await pixel(300, 140))[0] < 90, [await pixel(280, 330), await pixel(280, 230)]);
    await evalJs("document.querySelector('.board').dispatchEvent(new KeyboardEvent('keydown', { key: 'z', ctrlKey: true, bubbles: true }))"); await sleep(200);
    ok('undo puts it back', (await pixel(280, 230))[1] < 90 && (await pixel(280, 330)).join() === '255,255,255' && !(await selBox()));
    // the 选中 tool: a tap on a stroke picks it; Delete removes it; undo brings it back; a tap on nothing picks nothing
    await evalJs("document.querySelector('.bd-tool[data-tool=lasso]').click()");
    await pointer('mouse', [[280, 230]]); await sleep(150);
    const tapped = await selBox();
    await evalJs("document.querySelector('.board').dispatchEvent(new KeyboardEvent('keydown', { key: 'Delete', bubbles: true }))"); await sleep(200);
    const deleted = (await pixel(280, 230)).join() === '255,255,255';
    await evalJs("document.querySelector('.bd-bar [data-act=undo]').click()"); await sleep(200);
    await pointer('mouse', [[280, 230]]); await sleep(100); const again = await selBox();
    await pointer('mouse', [[600, 400]]); await sleep(100);
    ok('a tap with the 选中 tool picks the stroke under it; Delete removes it; a tap on nothing lets go', tapped && tapped[2] > 380 && deleted && (await pixel(280, 230))[1] < 90 && again && !(await selBox()), [tapped, deleted, again]);
    await sleep(1700);
    ok('all of it is saved as it now is (4 strokes, the red one where it was)', (await strokesOf()).length === 4 && Math.abs((await strokesOf())[3].p[1] / (await strokesOf())[0].p[1] - 200 / 80) < 0.02, (await strokesOf()).map((s) => s.p.slice(0, 2)));

    // ---- moving and zooming
    await evalJs("document.querySelector('.bd-tool[data-tool=pencil]').click()");
    await pointer('mouse', [[300, 300], [360, 340]], 'mouse', { button: 'middle', buttons: 4 }); await sleep(250);
    ok('the middle button drags the sheet', (await pixel(340, 270))[1] < 90 && (await pixel(280, 230)).join() === '255,255,255', [await pixel(340, 270), await pixel(280, 230)]);
    await call('Input.dispatchMouseEvent', { type: 'mouseWheel', x: box.x + 400, y: box.y + 300, deltaX: 0, deltaY: -200, modifiers: 2 }); await sleep(300);
    const zoomed = await evalJs("document.querySelector('.bd-zoom').textContent");
    ok('Ctrl + wheel zooms in', parseInt(zoomed) > 120, zoomed);
    // two fingers: pinch out
    const touch = (type, pts) => call('Input.dispatchTouchEvent', { type, touchPoints: pts.map(([x, y], i) => ({ ...B(x, y), id: i + 1, force: 0.5 })) });
    await touch('touchStart', [[300, 300]]); await touch('touchStart', [[300, 300], [400, 300]]);
    for (let i = 1; i <= 6; i++) await touch('touchMove', [[300 - i * 15, 300], [400 + i * 15, 300]]);
    await touch('touchEnd', []); await sleep(1700);
    const pinched = await evalJs("document.querySelector('.bd-zoom').textContent");
    ok('two fingers apart zoom in further, and draw nothing', parseInt(pinched) > parseInt(zoomed) * 1.5 && (await strokesOf()).length === 4, [zoomed, pinched, (await strokesOf()).length]);
    // one finger: moves (a pen was seen), draws once 手指画 is on
    await touch('touchStart', [[500, 400]]); await touch('touchMove', [[520, 420]]); await touch('touchMove', [[560, 440]]); await touch('touchEnd', []); await sleep(1700);
    const afterFinger = (await strokesOf()).length;
    await evalJs("document.querySelector('.bd-bar [data-act=finger]').click()");
    await touch('touchStart', [[500, 400]]); await touch('touchMove', [[520, 420]]); await touch('touchMove', [[560, 440]]); await touch('touchEnd', []); await sleep(1700);
    ok('one finger moves the sheet; with 手指画 on it draws', afterFinger === 4 && (await strokesOf()).length === 5, [afterFinger, (await strokesOf()).length]);
    await evalJs("document.querySelector('.bd-zoom').click()"); await sleep(300);
    ok('a click on the percentage puts the drawing back in view', parseInt(await evalJs("document.querySelector('.bd-zoom').textContent")) <= 100);
    await shot('board-2-fit.png');

    // ---- closed and opened again: the board is as it was
    await evalJs("[...document.querySelectorAll('.win')].find((w) => w.querySelector('.title').textContent === '画板').querySelector('.tbtn.close').click()"); await sleep(600);
    await evalJs("document.querySelector('.dicon[data-id=board]').dispatchEvent(new MouseEvent('dblclick', {bubbles:true}))"); await sleep(1500);
    ok('opened again: the same board with its strokes', await evalJs("document.querySelector('.bd-pick').selectedOptions[0].textContent.startsWith('画板 ')") && !(await evalJs("document.querySelector('.bd-bar [data-act=clear]').disabled")));

    // ---- to the model and back
    await evalJs("document.querySelector('.bd-bar [data-act=ai]').click()"); await sleep(4500);
    const frame = "document.querySelector('.bo-frame').contentDocument";
    const sheet = await evalJs(`(() => { const d = ${frame}; const s = d.querySelector('.sheet'); const r = s.getBoundingClientRect(), t = d.querySelector('.t').getBoundingClientRect(), m = d.querySelector('.m').getBoundingClientRect();
      return { w: r.width, h: r.height, texts: d.querySelectorAll('.t').length, katex: d.querySelectorAll('.katex').length, rects: d.querySelectorAll('svg rect').length, heads: d.querySelectorAll('svg polygon').length, cells: d.querySelectorAll('.tb td, .tb th').length,
        title: { left: (t.left - r.left) / r.width, size: parseFloat(getComputedStyle(d.querySelector('.t')).fontSize) / r.width }, math: { left: (m.left - r.left) / r.width, mid: (m.top + m.height / 2 - r.top) / r.height, color: getComputedStyle(d.querySelector('.m')).color },
        font: getComputedStyle(d.querySelector('.katex')).fontFamily, label: d.querySelector('.s').textContent, scripts: d.querySelectorAll('script').length }; })()`);
    ok('the 还原稿 shows in the window: pieces where they were written, formulas drawn, boxes and an arrow, a table', sheet && sheet.texts === 2 && sheet.katex >= 5 && sheet.rects === 2 && sheet.heads === 1 && sheet.cells === 6 &&
      Math.abs(sheet.title.left - 0.06) < 0.005 && Math.abs(sheet.title.size - 0.0352) < 0.002 && Math.abs(sheet.math.left - 0.06) < 0.005 && Math.abs(sheet.math.mid - 270 / (sheet.h / sheet.w * 1000)) < 0.01 &&
      sheet.math.color === 'rgb(217, 48, 37)' && /KaTeX_Main/.test(sheet.font) && sheet.label === '发射 <机>', sheet);
    ok('what the model was unsure of is said', /1 处拿不准/.test(await evalJs("document.querySelector('.bo-unsure summary').textContent")));
    await shot('board-3-restore.png');
    await evalJs("document.querySelector('.bo-tab[data-tab=md]').click()"); await sleep(900);
    ok('the text档 as Markdown, formulas drawn', await evalJs("document.querySelector('.bo-md h1').textContent === '雷达方程推导' && document.querySelectorAll('.bo-md .katex').length >= 2"));
    await evalJs("document.querySelector('.bo-tab[data-tab=shot]').click()"); await sleep(700);
    ok('the picture that was sent can be compared', await evalJs("(() => { const i = document.querySelector('.bo-shot img'); return i.complete && i.naturalWidth > 200; })()"));
    await evalJs("document.querySelector('.bo-tab[data-tab=design]').click()"); await sleep(400);
    await evalJs("(() => { const i = document.querySelector('.bo-wish'); i.value = '深色'; document.querySelector('.bo-design .btn').click(); })()"); await sleep(4500);
    const des = await evalJs(`(() => { const d = ${frame}; return { card: !!d.querySelector('.card'), bg: getComputedStyle(d.body).backgroundColor, katex: d.querySelectorAll('.katex').length, scripts: d.querySelectorAll('script').length, links: [...d.querySelectorAll('link')].map((l) => l.getAttribute('href')),
      onclick: d.querySelector('.card').getAttribute('onclick'), price: d.body.textContent.includes('$5 和 $10'), svg: d.querySelectorAll('svg rect').length, title: document.title, idea: document.querySelector('.bo-idea').textContent }; })()`);
    ok('the 设计稿: the model\'s own page with its style, formulas drawn, prices left alone', des && des.card && des.bg === 'rgb(15, 23, 42)' && des.katex === 2 && des.price && des.svg === 1 && /深色/.test(des.idea), des);
    ok('nothing of it runs or calls out: no script, no handler, no stylesheet from elsewhere', des && des.scripts === 0 && des.onclick == null && des.links.every((l) => l.startsWith(`http://127.0.0.1:${PORT}/vendor/katex/`)) && des.title !== 'pwned', des);
    await shot('board-4-design.png');

    // ---- saved as files
    await evalJs("[...document.querySelectorAll('.bo-bar .btn')].find((b) => b.textContent === '导出 HTML').click()"); await sleep(1500);
    await evalJs("document.querySelector('.bo-tab[data-tab=restore]').click()"); await sleep(600);
    await evalJs("[...document.querySelectorAll('.bo-bar .btn')].find((b) => b.textContent === '导出 HTML').click()"); await sleep(1500);
    const files = fs.existsSync(path.join(T, 'dl')) ? fs.readdirSync(path.join(T, 'dl')) : [];
    const read = (re) => { const f = files.find((n) => re.test(n)); return f ? fs.readFileSync(path.join(T, 'dl', f), 'utf8') : ''; };
    const rh = read(/还原稿\.html$/), dh = read(/设计稿\.html$/);
    ok('the exported pages carry everything inside: fonts as data, nothing from a server, a policy that loads nothing', rh.length > 100000 && /font\/woff2;base64,/.test(rh) && !/https?:\/\/127\.0\.0\.1/.test(rh) && !/url\(fonts\//.test(rh) && /default-src 'none'/.test(rh) && /class="sheet"/.test(rh) &&
      /font\/woff2;base64,/.test(dh) && !/127\.0\.0\.1/.test(dh) && !/<script/i.test(dh) && !/example\.com\/a\.css/.test(dh) && /class="card"/.test(dh), [files, rh.length, dh.length, rh.slice(0, 300)]);
    if (rh) fs.writeFileSync(path.join(OUT, 'board-restore.html'), rh);
    if (dh) fs.writeFileSync(path.join(OUT, 'board-design.html'), dh);

    // ---- a phone
    await call('Emulation.setDeviceMetricsOverride', { width: 390, height: 800, deviceScaleFactor: 2, mobile: true });
    await sleep(1200); await shot('board-5-phone.png');
    ws.close();
  } catch (e) { errors.push('script: ' + e.stack); }
  finally {
    try { chrome && chrome.kill(); } catch {}
    for (const k of kids) try { k.kill(); } catch {}
    await sleep(800);
    try { fs.rmSync(T, { recursive: true, force: true }); } catch {}
    console.log(errors.length ? 'ERRORS:\n' + errors.join('\n') : 'no page errors');
    console.log(`\n${pass} passed, ${fail + (errors.length ? 1 : 0)} failed`);
    process.exit(fail || errors.length ? 1 : 0);
  }
})();
