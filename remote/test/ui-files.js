// UI check: throwaway server + agent with fake sessions, headless Chrome over CDP (login cookie injected),
// screenshots at desktop and phone size, page errors collected.
const fs = require('fs'), path = require('path'), os = require('os'), http = require('http'), cp = require('child_process');
const R = require('path').resolve(__dirname, '..');
const WebSocket = require(R + '/node_modules/ws');
const auth = require(R + '/server/auth');
const SP = __dirname, OUT = path.join(SP, 'out', 'shots'); fs.mkdirSync(OUT, { recursive: true });
const T = fs.mkdtempSync(path.join(os.tmpdir(), 'ame-ui-'));
const HOME = path.join(T, 'home'), PROJ = path.join(HOME, '.claude', 'projects', '-proj-demo');
fs.mkdirSync(PROJ, { recursive: true });
const CFG = path.join(T, 'srv', 'config.json'); fs.mkdirSync(path.dirname(CFG));
const PORT = 18790, CDP = 9333;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const env = { ...process.env, AME_REMOTE_CONFIG: CFG };
const node = (args, extra = {}) => cp.execFileSync(process.execPath, args, { env: { ...env, ...extra } }).toString();
let n = 0;
const L = (o, t) => JSON.stringify({ uuid: 'u' + (++n), cwd: '/home/dell/demo', timestamp: new Date(t).toISOString(), ...o }) + '\n';
const now = Date.now();
node([R + '/server/setup.js', 'init'], { AME_USER: 'u', AME_PASSWORD: 'pw-123456789012' });
const cfg = JSON.parse(fs.readFileSync(CFG)); cfg.web.port = PORT; fs.writeFileSync(CFG, JSON.stringify(cfg));
const tok = node([R + '/server/setup.js', 'add-agent', 'dell97']).split('\n').map((s) => s.trim()).find((s) => /^[A-Za-z0-9_-]{30,}$/.test(s));
const SHARE = path.join(T, 'share'); fs.mkdirSync(path.join(SHARE, 'docs', 'img'), { recursive: true });
fs.writeFileSync(path.join(SHARE, 'docs', 'README.md'), ["# 网格加密说明","","下面是**示意图**：","","![网格示意](img/mesh.png)","","| 参数 | 值 |","|---|---|","| dx | 1e-3 |","","外链图片：![x](https://example.com/a.png)","","[看笔记](notes.txt)",""].join(String.fromCharCode(10)));
fs.copyFileSync(R + '/public/wall/illust_bike_inaba.webp', path.join(SHARE, 'docs', 'img', 'mesh.png'));
fs.writeFileSync(path.join(SHARE, 'docs', 'notes.txt'), ['中文笔记', 'line 2', ''].join(String.fromCharCode(10)));
// a CSV as Excel writes one: a cell with a comma and a line break in quotes, "" for a quote, CRLF; and 2 500 rows more
const CSV = ['名称,数值,备注', '"网格, 粗",1.5,"第一行' + String.fromCharCode(10) + '第二行"', '细网格,"2,048","他说 ""好"""', ',,']
  .concat(Array.from({ length: 2500 }, (_, i) => `r${i},${i},`)).join(String.fromCharCode(13, 10)) + String.fromCharCode(13, 10);
fs.writeFileSync(path.join(SHARE, 'docs', 'data.csv'), CSV);
const DL = path.join(T, 'downloads'); fs.mkdirSync(DL);
// a folder to download as a .zip: folders in folders, an empty one, a file over 100 MB (left out, and named in the
// zip), a secret (never listed, so never in it)
const PACK = path.join(SHARE, 'docs', 'pack'); fs.mkdirSync(path.join(PACK, 'sub', 'deep'), { recursive: true }); fs.mkdirSync(path.join(PACK, '空'));
fs.writeFileSync(path.join(PACK, 'a.txt'), 'top\n'); fs.writeFileSync(path.join(PACK, 'sub', 'deep', '中文.txt'), '深处的文件\n');
fs.writeFileSync(path.join(PACK, '.env'), 'TOKEN=x\n');
fs.writeFileSync(path.join(PACK, 'big.bin'), ''); fs.truncateSync(path.join(PACK, 'big.bin'), 101 * 1024 * 1024);
// a file over 100 MB on its own, every byte telling where it is (a download carried on from the wrong place shows)
const HUGE = Buffer.alloc(120 * 1024 * 1024); for (let i = 0; i < HUGE.length; i++) HUGE[i] = (i * 31 + (i >>> 16)) % 251;
fs.writeFileSync(path.join(SHARE, 'docs', 'huge.bin'), HUGE);
const sha = (b) => require('crypto').createHash('sha256').update(b).digest('hex');
const HUGE_SHA = sha(HUGE), ZERO_SHA = sha(Buffer.alloc(101 * 1024 * 1024));
const ACFG = path.join(T, 'agent.json');
fs.writeFileSync(ACFG, JSON.stringify({ server: `ws://127.0.0.1:${PORT}/agent`, token: tok, name: 'dell97', control: false, scanMs: 500, files: { roots: [SHARE], upload: true } }));
// a second computer with files of its own (我的电脑's computer switch)
const tok2 = node([R + '/server/setup.js', 'add-agent', 'box2']).split('\n').map((s) => s.trim()).find((s) => /^[A-Za-z0-9_-]{30,}$/.test(s));
const SHARE2 = path.join(T, 'share2'); fs.mkdirSync(SHARE2); fs.writeFileSync(path.join(SHARE2, 'on-box2.txt'), 'box2\n');
const HOME2 = path.join(T, 'home2'); fs.mkdirSync(path.join(HOME2, '.claude', 'projects'), { recursive: true });
const ACFG2 = path.join(T, 'agent2.json');
fs.writeFileSync(ACFG2, JSON.stringify({ server: `ws://127.0.0.1:${PORT}/agent`, token: tok2, name: 'box2', control: false, scanMs: 500, files: { roots: [SHARE2] } }));
fs.writeFileSync(path.join(PROJ, 'aaaaaaaa-1111-2222-3333-444444444444.jsonl'),
  L({ type: 'ai-title', aiTitle: 'FDTD 网格加密' }, now - 900e3) +
  L({ type: 'user', message: { role: 'user', content: '帮我把 FDTD 的网格在界面附近加密' } }, now - 800e3) +
  L({ type: 'assistant', message: { id: 'a1', role: 'assistant', content: [{ type: 'text', text: '好的，先看一下现在的网格生成：\n\n```python\ndx = 1e-3\n```\n我会在 **界面两侧** 各加密 5 层。' }] } }, now - 790e3) +
  L({ type: 'assistant', message: { id: 'a2', role: 'assistant', content: [{ type: 'tool_use', name: 'Read', input: { file_path: '/home/dell/demo/mesh.py' } }, { type: 'tool_use', name: 'Edit', input: { file_path: '/home/dell/demo/mesh.py' } }] } }, now - 780e3) +
  L({ type: 'assistant', message: { id: 'a3', role: 'assistant', content: [{ type: 'text', text: '改好了，网格数从 400 增加到 460。' }] } }, now - 60e3));
fs.writeFileSync(path.join(PROJ, 'bbbbbbbb-1111-2222-3333-444444444444.jsonl'),
  L({ type: 'user', message: { role: 'user', content: '跑一下测试' } }, now - 5e3));

const kids = [];
const spawn = (args, e) => { const p = cp.spawn(process.execPath, args, { env: { ...env, ...e }, stdio: 'ignore' }); kids.push(p); return p; };
function login() {
  return new Promise((resolve) => {
    const body = JSON.stringify({ user: 'u', password: 'pw-123456789012', code: auth.totpAt(JSON.parse(fs.readFileSync(CFG)).totpSecret, Math.floor(Date.now() / 30000)) });
    const req = http.request({ host: '127.0.0.1', port: PORT, path: '/api/login', method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: `http://127.0.0.1:${PORT}`, 'Content-Length': Buffer.byteLength(body) } },
    (res) => { res.resume(); resolve(String(res.headers['set-cookie'] || '').split(';')[0].split('=')); });
    req.end(body);
  });
}
const getJSON = (url, method = 'GET') => new Promise((resolve, reject) => { const r = http.request(url, { method }, (res) => { let b = ''; res.on('data', (c) => b += c); res.on('end', () => { try { resolve(JSON.parse(b)); } catch (e) { reject(e); } }); }); r.on('error', reject); r.end(); });

(async () => {
  const errors = [];
  let chrome;
  try {
    // a Word document (docx-fixture.js), and one in the old binary format
    fs.writeFileSync(path.join(SHARE, 'docs', '报告.docx'), await require('./docx-fixture.js').makeDocx(fs.readFileSync(R + '/public/icons/document.png')));
    fs.writeFileSync(path.join(SHARE, 'docs', '旧报告.doc'), Buffer.from('d0cf11e0a1b11ae1000000000000000000000000', 'hex'));
    spawn([R + '/server/server.js'], { AME_FLUSH_MS: '300' }); await sleep(3000);
    const agent1 = () => spawn([R + '/agent/agent.js'], { USERPROFILE: HOME, HOME, AME_AGENT_CONFIG: ACFG });
    let a1 = agent1(); await sleep(2500);
    spawn([R + '/agent/agent.js'], { USERPROFILE: HOME2, HOME: HOME2, AME_AGENT_CONFIG: ACFG2 }); await sleep(1500);
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
      if (o.method === 'Runtime.exceptionThrown') errors.push('exception: ' + JSON.stringify(o.params.exceptionDetails.exception && o.params.exceptionDetails.exception.description || o.params.exceptionDetails.text).slice(0, 300));
      if (o.method === 'Runtime.consoleAPICalled' && o.params.type === 'error') errors.push('console: ' + o.params.args.map((a) => a.value || a.description).join(' ').slice(0, 300));
      if (o.method === 'Log.entryAdded' && o.params.entry.level === 'error') errors.push('log: ' + o.params.entry.text.slice(0, 300) + ' ' + (o.params.entry.url || ''));
    });
    const call = (method, params = {}) => new Promise((r) => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
    const evalJs = async (expr) => (await call('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true })).result.result.value;
    const shot = async (name) => { const r = await call('Page.captureScreenshot', { format: 'png' }); fs.writeFileSync(path.join(OUT, name), Buffer.from(r.result.data, 'base64')); };
    await call('Runtime.enable'); await call('Log.enable'); await call('Page.enable');
    await call('Network.enable');
    await call('Network.setCookie', { name: cname, value: cval, url: `http://127.0.0.1:${PORT}/` });
    await call('Emulation.setDeviceMetricsOverride', { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
    await call('Page.navigate', { url: `http://127.0.0.1:${PORT}/` });
    await sleep(3500);

    const dbl = (sel) => evalJs(`(() => { const el = [...document.querySelectorAll('${sel.q}')].find(x => x.textContent.includes('${sel.t}')); if (!el) return false; el.dispatchEvent(new MouseEvent('dblclick', { bubbles: true })); return true; })()`);
    // (two computers now: dell97 picked in 网上邻居 first)
    await evalJs("[...document.querySelectorAll('.mach')].find(b => b.textContent.includes('dell97')).click()"); await sleep(500);
    console.log('open 我的电脑', await dbl({ q: '.dicon', t: '我的电脑' })); await sleep(1500);
    console.log('open root', await dbl({ q: '.xroot', t: 'share' })); await sleep(1200);
    console.log('open docs', await dbl({ q: '.xlist tr', t: 'docs' })); await sleep(1200);
    await shot('7-explorer.png');
    console.log('open README.md', await dbl({ q: '.xlist tr', t: 'README.md' })); await sleep(3000);
    console.log('md image loaded:', await evalJs("(() => { const i = document.querySelector('.md img'); return i ? i.naturalWidth + 'x' + i.naturalHeight : 'no img'; })()"));
    console.log('external image note:', await evalJs("(document.querySelector('.mdimg-note')||{}).textContent"));
    console.log('table rendered:', await evalJs("!!document.querySelector('.md table')"));
    await shot('8-markdown.png');
    await evalJs("document.querySelector('.md a').click()"); await sleep(1500);
    console.log('linked text file:', await evalJs("(document.querySelector('.vtext')||{}).textContent"));
    await shot('9-text.png');
    const res = [];
    const chk = (n, c, x) => res.push((c ? 'PASS ' : 'FAIL ') + n + (c ? '' : ' ' + JSON.stringify(x)));
    // a CSV: a table, the heads from its first row, the quoted cells whole, numbers to the right, a page of rows at a time
    console.log('open data.csv', await dbl({ q: '.xlist tr', t: 'data.csv' })); await sleep(2500);
    const tbl = () => evalJs("(() => { const v = [...document.querySelectorAll('.viewer')].find(x => x.querySelector('.vpath').textContent.endsWith('data.csv')); const t = v.querySelector('table.csv'); return { info: (v.querySelector('.vinfo') || {}).textContent, as: (v.querySelector('.vtools .btn') || {}).textContent, heads: t ? [...t.querySelectorAll('thead th')].map(x => x.textContent) : null, r1: t ? [...t.querySelectorAll('tbody tr:first-child td')].map(x => x.textContent) : null, r2: t ? [...t.querySelectorAll('tbody tr:nth-child(2) td')].map(x => x.textContent + (x.classList.contains('num') ? '#' : '')) : null, n: t ? t.querySelectorAll('tbody tr').length : 0, more: (v.querySelector('.csvmore .btn') || {}).textContent, raw: (v.querySelector('.vtext') || {}).textContent || '' }; })()");
    let tb = await tbl();
    chk('CSV: a table with its heads, rows and columns counted, the separator named', tb.info === '2503 行 × 3 列 · 逗号分隔' && tb.heads.join('|') === '|名称|数值|备注' && tb.as === '原文', tb);
    chk('CSV: a quoted cell with a comma or a line break in it is one cell; "" is a quote; numbers marked', tb.r1.join('|') === '1|网格, 粗|1.5|第一行' + String.fromCharCode(10) + '第二行' && tb.r2.join('|') === '2|细网格|2,048#|他说 "好"', [tb.r1, tb.r2]);
    chk('CSV: a thousand rows at first, a button for the next', tb.n === 1000 && tb.more === '再显示 1000 行（还有 1503 行）', [tb.n, tb.more]);
    await shot('9c-csv.png');
    await evalJs("[...document.querySelectorAll('.viewer .csvmore .btn')].pop().click()"); await sleep(400);
    tb = await tbl();
    chk('CSV: 再显示 adds the next thousand', tb.n === 2000 && tb.more === '再显示 503 行（还有 503 行）', [tb.n, tb.more]);
    await evalJs("[...document.querySelectorAll('.viewer .vtools .btn')].pop().click()"); await sleep(300);
    tb = await tbl();
    chk('CSV: 原文 shows the text as it is (and the button says 表格 to go back)', tb.as === '表格' && tb.raw.startsWith('名称,数值,备注') && !tb.heads, [tb.as, tb.raw.slice(0, 30)]);
    // a Word document: drawn page by page -- heading, table, picture; a web link opens in a new tab, a javascript:
    // one is no link at all
    console.log('open 报告.docx', await dbl({ q: '.xlist tr', t: '报告.docx' }));
    const wv = "[...document.querySelectorAll('.viewer')].find(x => x.querySelector('.vpath').textContent.endsWith('报告.docx'))";
    const wd = async () => evalJs(`(() => { const v = ${wv}; if (!v) return null; const w = v.querySelector('.docx-wrap'); const img = w && w.querySelector('section.docx img'); const links = w ? [...w.querySelectorAll('a')].map(a => [a.textContent, a.getAttribute('href'), a.target]) : [];
      return { pages: w ? w.querySelectorAll('section.docx').length : 0, info: (v.querySelector('.vinfo') || {}).textContent, text: w ? w.textContent : (v.querySelector('.vbody') || {}).textContent, cells: w ? [...w.querySelectorAll('td')].map(t => t.textContent) : [],
        img: img ? img.naturalWidth : -1, links, fonts: w ? w.querySelectorAll('style').length : 0, zoom: w ? w.querySelector('.docx-pages').style.zoom : '' }; })()`);
    let wdoc = null;
    for (let i = 0; i < 40 && !(wdoc && wdoc.pages); i++) { await sleep(250); wdoc = await wd(); }
    await sleep(500); wdoc = await wd();
    await shot('9d-word.png');
    chk('Word: two pages drawn, counted in the bar', wdoc && wdoc.pages === 2 && wdoc.info === '2 页', wdoc);
    chk('Word: the heading, the text, the table, the picture', /网格加密报告/.test(wdoc.text) && /界面两侧各加密 5 层/.test(wdoc.text) && /第二页的内容/.test(wdoc.text) && wdoc.cells.join('|') === '参数|值|dx|1e-3' && wdoc.img === 32, wdoc);
    const web = wdoc.links.find((l) => l[0] === '外部链接'), bad = wdoc.links.find((l) => l[0] === '坏链接');
    chk('Word: a web link opens in a new tab; a javascript: link is no link', web && web[1] === 'https://example.com/report' && web[2] === '_blank' && (!bad || bad[1] == null), wdoc.links);
    // on a phone the page is scaled to the width
    await call('Emulation.setDeviceMetricsOverride', { width: 390, height: 800, deviceScaleFactor: 2, mobile: true }); await sleep(800);
    const narrow = await wd();
    await call('Emulation.setDeviceMetricsOverride', { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false }); await sleep(500);
    chk('Word: a narrow window shows the whole page width (scaled down)', narrow && +narrow.zoom > 0 && +narrow.zoom < 1, narrow && narrow.zoom);
    await evalJs(`(${wv}).closest('.win').querySelector('.tb-close, .close, [data-act=close]') && (${wv}).closest('.win').querySelector('.tb-close, .close, [data-act=close]').click()`);
    console.log('open 旧报告.doc', await dbl({ q: '.xlist tr', t: '旧报告.doc' })); await sleep(1500);
    const old = await evalJs("(() => { const v = [...document.querySelectorAll('.viewer')].find(x => x.querySelector('.vpath').textContent.endsWith('旧报告.doc')); return v ? v.querySelector('.vbody').textContent : ''; })()");
    chk('Word, the old .doc: says it cannot be drawn and how to see it', /老版 Word 格式/.test(old) && /另存为 \.docx/.test(old), old);
    // 下载 in 我的电脑: the file picked in the list, saved under its own name, byte for byte
    await call('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: DL });
    const ex = "[...document.querySelectorAll('.explorer')].find(e => e.querySelector('.xpc').value === 'dell97')";
    const dlState = () => evalJs(`(() => { const e = ${ex}; const b = [...e.querySelectorAll('.xbar .btn')].find(x => /下载/.test(x.textContent)); return { text: b.textContent, disabled: b.disabled, status: e.querySelector('.xstatus').textContent }; })()`);
    chk('下载: nothing picked, nothing to download', (await dlState()).disabled, await dlState());
    await evalJs(`(() => { const e = ${ex}; [...e.querySelectorAll('.xlist tr')].find(x => x.textContent.includes('data.csv')).click(); [...e.querySelectorAll('.xbar .btn')].find(x => x.textContent === '下载').click(); })()`);
    let saved = '';
    for (let i = 0; i < 30 && !saved; i++) { await sleep(300); const f = path.join(DL, 'data.csv'); if (fs.existsSync(f) && fs.statSync(f).size === Buffer.byteLength(CSV)) saved = fs.readFileSync(f, 'utf8'); }
    const st = await dlState();
    chk('下载: the file saved under its name, as it is on the computer', saved === CSV && /^已下载 data.csv/.test(st.status) && st.text === '下载' && !st.disabled, [saved.length, st]);
    // a folder: all of it as <name>.zip, what could not come along named in a file beside it -- in a browser that
    // cannot write to disk (Firefox, a phone), where a file over 100 MB has to stay behind
    await evalJs('window.showSaveFilePicker = undefined; window.showDirectoryPicker = undefined;');
    await evalJs(`(() => { const e = ${ex}; [...e.querySelectorAll('.xlist tr')].find(x => x.textContent.includes('pack')).click(); })()`);
    chk('下载: a folder picked can be downloaded', !(await dlState()).disabled, await dlState());
    await evalJs(`(() => { const e = ${ex}; [...e.querySelectorAll('.xbar .btn')].find(x => x.textContent === '下载').click(); })()`);
    const ZIP = path.join(DL, 'pack.zip');
    for (let i = 0; i < 40 && !(fs.existsSync(ZIP) && /^已下载/.test((await dlState()).status)); i++) await sleep(300);
    const zs = await dlState();
    const TAR = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe'), X = path.join(T, 'unzip');
    // (unpacked by Windows' own tar, the folders read back: the names as a zip program sees them)
    const tree = (d, pre = '') => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => e.isDirectory() ? [pre + e.name + '/', ...tree(path.join(d, e.name), pre + e.name + '/')] : [pre + e.name]);
    let names = [];
    try { fs.mkdirSync(X); cp.execFileSync(TAR, ['-xf', ZIP, '-C', X]); names = tree(X).sort(); } catch (e) { names = ['tar: ' + e.message]; }
    const rd = (...p) => { try { return fs.readFileSync(path.join(X, ...p), 'utf8'); } catch { return null; } };
    chk('下载 a folder: pack.zip with its folders, the empty one too; no secret, no file over 100 MB',
      names.join('|') === ['pack/', 'pack/a.txt', 'pack/sub/', 'pack/sub/deep/', 'pack/sub/deep/中文.txt', 'pack/空/', '未打包的文件.txt'].sort().join('|'), names);
    chk('下载 a folder: the files as they are', rd('pack', 'a.txt') === 'top\n' && rd('pack', 'sub', 'deep', '中文.txt') === '深处的文件\n', [rd('pack', 'a.txt'), rd('pack', 'sub', 'deep', '中文.txt')]);
    chk('下载 a folder: what was left out, and why, in 未打包的文件.txt', /pack\/big\.bin —— 超过 100 MB/.test(rd('未打包的文件.txt') || '') && !/\.env/.test(rd('未打包的文件.txt') || ''), rd('未打包的文件.txt'));
    chk('下载 a folder: the status line says what came', /^已下载 pack\.zip（2 个文件，.*有 1 项没能打包/.test(zs.status) && zs.text === '下载', zs);

    // Chrome / Edge on a computer: written to disk as it comes. (The pickers give folders of the page's own private
    // file system here: a test cannot click in the system's dialog.)
    await evalJs(`(async () => {
      window.__picked = [];
      const root = await navigator.storage.getDirectory();
      window.showSaveFilePicker = async (o) => { __picked.push('save:' + o.suggestedName); return root.getFileHandle(o.suggestedName, { create: true }); };
      window.showDirectoryPicker = async (o) => { __picked.push('dir:' + o.mode); return root; };
    })()`);
    // (what is in the private file system: names, "/" after a folder; the sha-256 of a file)
    const opfsTree = () => evalJs(`(async () => { const out = []; const go = async (d, pre) => { for await (const [n, h] of d.entries()) { if (h.kind === 'directory') { out.push(pre + n + '/'); await go(h, pre + n + '/'); } else out.push(pre + n); } }; await go(await navigator.storage.getDirectory(), ''); return out.sort(); })()`);
    const opfsFile = (p, hash) => evalJs(`(async () => { let d = await navigator.storage.getDirectory(); const s = ${JSON.stringify(p)}.split('/'); for (const n of s.slice(0, -1)) d = await d.getDirectoryHandle(n); const f = await (await d.getFileHandle(s.pop())).getFile();
      if (!${hash}) return await f.text(); const h = await crypto.subtle.digest('SHA-256', await f.arrayBuffer()); return f.size + ':' + [...new Uint8Array(h)].map(b => b.toString(16).padStart(2, '0')).join(''); })().catch(e => 'error: ' + e.message)`);
    const statuses = new Set();
    const waitStatus = async (re, ms, during) => { for (let t = 0; t < ms; t += 100) { const s = await dlState(); statuses.add(s.status); if (re.test(s.status)) return s; if (during) await during(s); await sleep(100); } return dlState(); };
    // a folder with a file over 100 MB: a button in the status line asks where; then folders and files as they were
    await evalJs(`(() => { const e = ${ex}; [...e.querySelectorAll('.xbar .btn')].find(x => x.textContent === '下载').click(); })()`);
    let ds = await waitStatus(/选择保存位置/, 8000);
    chk('下载 a folder to disk: too large for a zip, the status line asks where to save it', /有 1 个文件超过 100 MB.*选择保存位置…$/.test(ds.status) && ds.text === '取消下载', ds);
    await evalJs(`(() => { const e = ${ex}; e.querySelector('.xstatus .xact').click(); })()`);
    ds = await waitStatus(/^已下载到|^已取消|失败/, 60000);
    const ot = await opfsTree();
    chk('下载 a folder to disk: written into the folder picked, the empty folder and the file over 100 MB too',
      /^已下载到「pack」（3 个文件，/.test(ds.status) && ot.join('|') === ['pack/', 'pack/a.txt', 'pack/big.bin', 'pack/sub/', 'pack/sub/deep/', 'pack/sub/deep/中文.txt', 'pack/空/'].sort().join('|') && (await evalJs('__picked.join()')) === 'dir:readwrite', [ds, ot]);
    chk('下载 a folder to disk: the files as they are', (await opfsFile('pack/a.txt', false)) === 'top\n' && (await opfsFile('pack/sub/deep/中文.txt', false)) === '深处的文件\n' && (await opfsFile('pack/big.bin', true)) === `${101 * 1024 * 1024}:${ZERO_SHA}`, 0);
    // a single file over 100 MB: 另存为, written as it comes; the computer's agent stopped halfway and started again:
    // it carries on from where it was, and the file comes out whole
    await evalJs(`(() => { const e = ${ex}; [...e.querySelectorAll('.xlist tr')].find(x => x.textContent.includes('huge.bin')).click(); [...e.querySelectorAll('.xbar .btn')].find(x => x.textContent === '下载').click(); })()`);
    let cut = false;
    ds = await waitStatus(/^已保存|huge\.bin：/, 120000, async (s) => {
      const m = /… ([\d.]+) MB \//.exec(s.status);
      if (!cut && m && +m[1] >= 20) { cut = true; a1.kill(); await sleep(1500); a1 = agent1(); }
    });
    const hs = await opfsFile('huge.bin', true);
    chk('下载 a large file: 另存为, the agent cut off halfway, carried on, the file whole',
      cut && /^已保存 huge\.bin（120\.0 MB）/.test(ds.status) && [...statuses].some((s) => /接着下载/.test(s)) && hs === `${HUGE.length}:${HUGE_SHA}` && (await evalJs('__picked.join()')) === 'dir:readwrite,save:huge.bin',
      [cut, ds.status, [...statuses].filter((s) => /接着|断/.test(s)), String(hs).slice(0, 30)]);
    await shot('9d-download-disk.png');

    // 上传: files from this device into the folder open (docs), through the real file input; the agent stopped halfway
    // through the large one and started again: it carries on, and both arrive whole
    const LOCAL = path.join(T, 'local'); fs.mkdirSync(LOCAL);
    const UPBIG = Buffer.from(HUGE.subarray(0, 110 * 1024 * 1024)).reverse();
    fs.writeFileSync(path.join(LOCAL, 'up-big.bin'), UPBIG); fs.writeFileSync(path.join(LOCAL, '上传说明.txt'), '第一版\n');
    const waitFor = async (get, cond, ms) => { let s; for (let t = 0; t < ms; t += 100) { s = await get(); if (cond(s)) return s; await sleep(100); } return s; };
    const upState = () => evalJs(`(() => { const e = ${ex}; const b = [...e.querySelectorAll('.xbar .btn')].find(x => /上传/.test(x.textContent)); return { text: b.textContent, disabled: b.disabled, status: e.querySelector('.xstatus').textContent, rows: [...e.querySelectorAll('.xlist tr')].map(x => x.textContent) }; })()`);
    chk('上传: the button there in a folder of a computer that takes uploads', !(await upState()).disabled, await upState());
    const setFiles = async (files) => {
      const o = (await call('Runtime.evaluate', { expression: `${ex}.querySelector('input.xupin')` })).result.result;
      return call('DOM.setFileInputFiles', { objectId: o.objectId, files });
    };
    await call('DOM.enable');
    await setFiles([path.join(LOCAL, '上传说明.txt'), path.join(LOCAL, 'up-big.bin')]);
    const upSeen = new Set();
    let upCut = false, us = null;
    for (let t = 0; t < 120000; t += 100) {
      us = await upState(); upSeen.add(us.status);
      if (/^已上传|没有上传|已取消/.test(us.status)) break;
      const m = /up-big\.bin（2\/2）：([\d.]+) MB \//.exec(us.status);
      if (!upCut && m && +m[1] >= 20) { upCut = true; a1.kill(); await sleep(1500); a1 = agent1(); }
      await sleep(100);
    }
    const DOCS = path.join(SHARE, 'docs');
    chk('上传: both files there, the large one whole after the cut, carried on',
      upCut && /^已上传 2 个文件到 /.test(us.status) && [...upSeen].some((s) => /接着上传/.test(s)) && fs.readFileSync(path.join(DOCS, '上传说明.txt'), 'utf8') === '第一版\n' &&
      sha(fs.readFileSync(path.join(DOCS, 'up-big.bin'))) === sha(UPBIG) && fs.readdirSync(DOCS).every((x) => !x.endsWith('.ame-upload')),
      [upCut, us.status, [...upSeen].filter((s) => /接着|断/.test(s)), fs.readdirSync(DOCS)]);
    chk('上传: the list shows them (read again, the status line kept)', us.rows.some((x) => x.includes('up-big.bin')) && us.rows.some((x) => x.includes('上传说明.txt')) && us.text === '上传', [us.text, us.rows]);
    // the same name again: asked first; 替换 replaces it
    fs.writeFileSync(path.join(LOCAL, '上传说明.txt'), '第二版\n');
    await setFiles([path.join(LOCAL, '上传说明.txt')]);
    let ask = '';
    for (let t = 0; t < 8000 && !ask; t += 100) { await sleep(100); ask = await evalJs("(document.querySelector('.dlgmsg .dlgtx') || {}).textContent || ''"); }
    await shot('9e-upload-replace.png');
    await evalJs("[...document.querySelectorAll('.dlgmsg .btn')].find(b => b.textContent === '替换').click()");
    us = await waitFor(upState, (s) => /^已上传 1 |没有上传/.test(s.status), 15000);
    chk('上传 the same name: asked first, then replaced', /已经有了/.test(ask) && /^已上传 1 个文件/.test(us.status) && fs.readFileSync(path.join(DOCS, '上传说明.txt'), 'utf8') === '第二版\n', [ask, us.status]);
    // 我的电脑's computer switch: the list of computers, this one shown; another one picked: its own window, the desktop follows
    const wins = () => evalJs("[...document.querySelectorAll('.win')].filter(w => w.querySelector('.explorer')).map(w => ({ title: w.querySelector('.ttl, .title, .wt') ? w.querySelector('.ttl, .title, .wt').textContent : w.textContent.slice(0, 40), pc: w.querySelector('.xpc').value, opts: [...w.querySelectorAll('.xpc option')].map(o => o.value) }))");
    let w = await wins();
    chk('我的电脑: a computer list with both, this one shown', w.length === 1 && w[0].pc === 'dell97' && w[0].opts.join() === 'box2,dell97', w);
    await evalJs("(() => { const s = document.querySelector('.explorer .xpc'); s.value = 'box2'; s.dispatchEvent(new Event('change')); })()"); await sleep(1800);
    w = await wins();
    chk('switching to box2: its own 我的电脑 opens (the dell97 one stays as it was)', w.length === 2 && w.some((x) => x.pc === 'box2') && w.some((x) => x.pc === 'dell97'), w);
    chk('box2\'s files shown', await evalJs("[...document.querySelectorAll('.explorer')].some(e => e.querySelector('.xpc').value === 'box2' && e.textContent.includes('share2'))"), 0);
    chk('the desktop follows (as picking box2 in 网上邻居)', (await evalJs('localStorage.getItem("ame.machine")')) === '"box2"', await evalJs('localStorage.getItem("ame.machine")'));
    await shot('9b-explorer-switch.png');
    // the files need a code entered within the hour (server/fs-relay.js): on a server where it lasts 4 s, opening a
    // folder asks for the code, and once it is in the folder opens (the same request sent again)
    const nErr = errors.length;
    for (const k of kids.splice(0, 1)) k.kill(); await sleep(500);
    spawn([R + '/server/server.js'], { AME_FLUSH_MS: '300', AME_FRESH_MS: '4000' }); await sleep(3000);
    const [c2n, c2v] = await login();
    await call('Network.setCookie', { name: c2n, value: c2v, url: `http://127.0.0.1:${PORT}/` });
    errors.splice(nErr);                                // (the page's socket while the server was away, then its old login)
    await call('Page.navigate', { url: `http://127.0.0.1:${PORT}/` }); await sleep(5500);
    const gateOpen = () => evalJs("!document.querySelector('#gate').hidden");
    const box2Text = () => evalJs("[...document.querySelectorAll('.explorer')].filter(e => e.querySelector('.xpc').value === 'box2').map(e => e.textContent).join('|')");
    if (!(await evalJs("!!document.querySelector('.explorer')"))) await dbl({ q: '.dicon', t: '我的电脑' });
    let g = await waitFor(gateOpen, (x) => x, 4000), want = 'share2';
    if (!g) { await dbl({ q: '.xroot', t: 'share2' }); g = await waitFor(gateOpen, (x) => x, 4000); want = 'on-box2.txt'; }
    const before = await box2Text();
    await shot('9f-files-code.png');
    const code2 = auth.totpAt(JSON.parse(fs.readFileSync(CFG)).totpSecret, Math.floor(Date.now() / 30000) + 1);
    await evalJs(`(() => { document.querySelector('#gate input').value = '${code2}'; document.querySelector('#gate form').requestSubmit(); })()`);
    const after = await waitFor(box2Text, (s) => s.includes(want), 6000);
    chk('a stale code: opening a folder asks for it, then opens it', g && !before.includes(want) && after.includes(want) && !(await gateOpen()), [g, want, before.slice(0, 120), after.slice(0, 120)]);
    console.log(res.join('\n'));
    ws.close();
  } catch (e) { errors.push('script: ' + e.stack); }
  finally {
    try { chrome && chrome.kill(); } catch {}
    for (const k of kids) try { k.kill(); } catch {}
    await sleep(800);
    try { fs.rmSync(T, { recursive: true, force: true }); } catch {}
    console.log(errors.length ? 'ERRORS:\n' + errors.join('\n') : 'no page errors');
    console.log('shots in', OUT);
    process.exit(0);
  }
})();
