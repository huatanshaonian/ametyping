// UI check (邮件): throwaway server keeping a fake mailbox (test/fake-imap.js) plus one with a refused password,
// headless Chrome over CDP (login cookie injected): the mail window (list, a message), 邮箱设置, the tray's warning,
// phone size; page errors collected. Shots in test/out/shots/7x-mail-*.png.
const fs = require('fs'), path = require('path'), os = require('os'), http = require('http'), cp = require('child_process');
const R = path.resolve(__dirname, '..');
const WebSocket = require(R + '/node_modules/ws');
const auth = require(R + '/server/auth');
const { createFakeImap } = require('./fake-imap');
const { makePdf } = require('./make-pdf');
const OUT = path.join(__dirname, 'out', 'shots'); fs.mkdirSync(OUT, { recursive: true });
const T = fs.mkdtempSync(path.join(os.tmpdir(), 'ame-uimail-'));
const PORT = 18840, IMAP = 18841, CDP = 9341;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const CFG = path.join(T, 'srv', 'config.json'); fs.mkdirSync(path.dirname(CFG));
const env = { ...process.env, AME_REMOTE_CONFIG: CFG, NODE_TLS_REJECT_UNAUTHORIZED: '0', AME_MAIL_TRIAGE_MS: '500', AME_SUMMARY_TICK_MS: '600000' };
cp.execFileSync(process.execPath, [R + '/server/setup.js', 'init'], { env: { ...env, AME_USER: 'u', AME_PASSWORD: 'pw-123456789012' } });
const cfg = JSON.parse(fs.readFileSync(CFG)); cfg.web.port = PORT; cfg.summary = { proxies: [], codex: [process.execPath, path.join(__dirname, 'fake-codex.js')] }; fs.writeFileSync(CFG, JSON.stringify(cfg));
// two mailboxes in mail.json already: one fine, one whose password is refused
fs.mkdirSync(path.join(T, 'srv', 'data'), { recursive: true });
const srvAcc = (id, address, pass, name) => ({ id, address, name, imap: { host: '127.0.0.1', port: IMAP }, smtp: { host: 'mail.cstnet.cn', port: 465 }, pass, added: Date.now() });
fs.writeFileSync(path.join(T, 'srv', 'data', 'mail.json'), JSON.stringify({ accounts: [srvAcc('a1', 'zhangsan@test.ac.cn', 'right', '所里'), srvAcc('a2', 'zhangsan@ucas.ac.cn', 'old', '国科大')], state: {} }));

cp.execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', path.join(T, 'k.pem'), '-out', path.join(T, 'c.pem'), '-days', '1', '-subj', '/CN=localhost'], { stdio: 'ignore' });
const imap = createFakeImap({ key: fs.readFileSync(path.join(T, 'k.pem')), cert: fs.readFileSync(path.join(T, 'c.pem')), users: { 'zhangsan@test.ac.cn': 'right' } });
const b64 = (s) => Buffer.from(s, 'utf8').toString('base64');
// to: "to|cc"
const mail = (from, to, subject, text, ago, extra = '') => imap.add(`From: ${from}\r\nTo: ${to.split('|')[0]}\r\n${to.includes('|') ? 'Cc: ' + to.split('|')[1] + '\r\n' : ''}Subject: =?UTF-8?B?${b64(subject)}?=\r\nDate: ${new Date(Date.now() - ago).toUTCString()}\r\n` +
  `Message-ID: <${Math.random()}@t>\r\n${extra}MIME-Version: 1.0\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Transfer-Encoding: base64\r\n\r\n${b64(text)}\r\n`, { date: Date.now() - ago });
mail('"李老师" <li@test.ac.cn>', 'zhangsan@test.ac.cn', '组会改到周四下午三点', '各位：\n\n本周组会改到周四下午三点，地点 305 会议室。请准备一下各自的进展，每人十分钟。\n\n李', 3 * 3600e3);
mail('"财务处" <caiwu@test.ac.cn>', 'all@test.ac.cn|zhangsan@test.ac.cn', '关于 2026 年度经费报销截止时间的通知', '各课题组：\n\n今年的报销截止到 12 月 15 日，请尽快整理发票。', 26 * 3600e3);
mail('"所里通讯" <news@lists.test.ac.cn>', 'staff@lists.test.ac.cn', '所里通讯第 12 期：新楼启用', '本期内容：新楼启用、学术报告预告……', 30 * 3600e3, 'List-Id: <staff.lists.test.ac.cn>\r\n');
for (const n of [1, 2]) mail('"院刊" <bulletin@cas.cn>', 'staff' + n + '@test.ac.cn', '中国科学院院刊 2026 年第 9 期',
  `本期目录：\n1. 面向 6G 的电磁超表面\n全文在线阅读：https://bulletin.cas.cn/2026/9?from=list${n}\n退订请写信到 u${n}@cas.cn`, 20 * 3600e3, 'List-Id: <bulletin.cas.cn>\r\n');
{ const d = new Date(Date.now() + 9 * 86400e3), due = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  mail('"研究生部" <yjs@test.ac.cn>', 'all@test.ac.cn', '学位论文提交通知', `各位同学：\n请于 ${due} 前在系统中提交学位论文电子版，逾期不予受理。`, 6 * 3600e3); }
{ const pdf = makePdf(['Radar cross section of a metasurface', 'Page two: results']).toString('base64');
  imap.add(`From: "王同学" <wang@test.ac.cn>
To: zhangsan@test.ac.cn
Subject: =?UTF-8?B?${b64('论文初稿请看')}?=
Date: ${new Date(Date.now() - 40 * 3600e3).toUTCString()}
Message-ID: <pdf@t>
` +
    `MIME-Version: 1.0
Content-Type: multipart/mixed; boundary="bb"

--bb
Content-Type: text/plain; charset=utf-8

see attachment
` +
    `--bb
Content-Type: application/pdf; name="paper.pdf"
Content-Disposition: attachment; filename="paper.pdf"
Content-Transfer-Encoding: base64

${pdf}
--bb--
`, { date: Date.now() - 40 * 3600e3 }); }
mail('"王同学" <wang@test.ac.cn>', 'zhangsan@test.ac.cn', 'RCS 仿真数据', '师兄，数据我放在共享盘了，帮忙看一下第三组的结果是不是不对。', 50 * 3600e3);

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
  await imap.listen(IMAP);
  const errors = [], res = [];
  const chk = (n, c, x) => res.push((c ? 'PASS ' : 'FAIL ') + n + (c ? '' : ' ' + JSON.stringify(x)));
  const srv = cp.spawn(process.execPath, [R + '/server/server.js'], { env, stdio: 'ignore' });
  let chrome;
  try {
    await sleep(3000);
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
      if (o.method === 'Log.entryAdded' && o.params.entry.level === 'error') errors.push('log: ' + o.params.entry.text.slice(0, 300) + ' ' + (o.params.entry.url || ''));
    });
    const call = (method, params = {}) => new Promise((r) => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
    const evalJs = async (expr) => (await call('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true })).result.result.value;
    const shot = async (name) => { const r = await call('Page.captureScreenshot', { format: 'png' }); fs.writeFileSync(path.join(OUT, name), Buffer.from(r.result.data, 'base64')); };
    await call('Runtime.enable'); await call('Log.enable'); await call('Page.enable'); await call('Network.enable');
    await call('Network.setCookie', { name: cname, value: cval, url: `http://127.0.0.1:${PORT}/` });
    await call('Emulation.setDeviceMetricsOverride', { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
    await call('Page.navigate', { url: `http://127.0.0.1:${PORT}/` });
    await sleep(3500);

    for (let i = 0; i < 40 && !(await evalJs("!!document.getElementById('mbell')")); i++) await sleep(500);
    chk('the tray rings: one alert (mail from the first sync: only a deadline still ahead)', (await evalJs("(document.getElementById('mbell')||{}).textContent||''")) === '1', await evalJs("document.getElementById('tray').textContent"));
    await evalJs("document.getElementById('mbell').click()"); await sleep(1200);
    const alTxt = await evalJs("(document.querySelector('.mal')||{}).textContent||''");
    chk('邮件提醒: the thesis notice (to do, deadline in days, the sentence, 加入重要计划)', /要办/.test(alTxt) && /截止/.test(alTxt) && /还有 9 天/.test(alTxt) && /原文|请于/.test(alTxt) && /加入重要计划/.test(alTxt), alTxt.slice(0, 400));
    await shot('75-mail-alerts.png');
    await evalJs("[...document.querySelectorAll('.win')].forEach(w => { const t = w.querySelector('.title'); if (t && t.textContent === '邮件提醒') w.querySelector('.tbtn.close').click(); })"); await sleep(300);
    chk('the tray warns about the mailbox whose password is refused', await evalJs("!!document.getElementById('mwarn') && document.getElementById('mwarn').title.includes('zhangsan@ucas.ac.cn')"), await evalJs("document.getElementById('tray').innerHTML"));
    await evalJs("[...document.querySelectorAll('.dicon')].find(b => b.textContent.includes('邮件')).dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))"); await sleep(1500);
    const listTxt = await evalJs("(document.querySelector('.ml-list')||{}).textContent||''");
    chk('the list: newest first, with the tags', listTxt.indexOf('组会改到周四') < listTxt.indexOf('经费报销') && /直/.test(listTxt) && /群/.test(listTxt) && /抄/.test(listTxt), listTxt.slice(0, 300));
    chk('the status line names the refused mailbox', (await evalJs("document.querySelector('.ml-st').textContent")).includes('国科大'), await evalJs("document.querySelector('.ml-st').textContent"));
    chk('unread in bold; the journal sent twice is one entry, ×2', await evalJs("document.querySelectorAll('.ml-i.unread').length === 7") &&
      (await evalJs("[...document.querySelectorAll('.ml-i')].filter(i => i.textContent.includes('院刊 2026')).length")) === 1 && (await evalJs("[...document.querySelectorAll('.ml-i')].find(i => i.textContent.includes('院刊 2026')).textContent")).includes('×2'),
      await evalJs("document.querySelector('.ml-list').textContent.slice(0, 400)"));
    await evalJs("[...document.querySelectorAll('.ml-i')].find(i => i.textContent.includes('院刊 2026')).click()"); await sleep(800);
    chk('the journal: the picks of the model shown above the text', (await evalJs("(document.querySelector('.ml-judge')||{}).textContent||''")).includes('面向 6G 的电磁超表面'), await evalJs("(document.querySelector('.ml-judge')||{}).textContent"));
    chk('its link is clickable (new tab), the trailing text not part of it', await evalJs("(() => { const a = document.querySelector('.ml-text a'); return !!a && a.href === 'https://bulletin.cas.cn/2026/9?from=list1' || a.href === 'https://bulletin.cas.cn/2026/9?from=list2' ? a.target === '_blank' && a.rel.includes('noopener') : false; })()"), await evalJs("document.querySelector('.ml-text').innerHTML.slice(0, 300)"));
    await shot('74-mail-journal.png');
    await evalJs("[...document.querySelectorAll('.ml-acts .btn')].find(b => b.textContent === '标为已读').click()"); await sleep(2500);
    chk('标为已读: both copies read in the mailbox, no longer bold', imap.box.msgs.filter((m) => /院刊/.test(Buffer.from(m.raw).toString()) || /bulletin/.test(m.raw.toString())).every((m) => m.flags.some((f) => /Seen/.test(f))) &&
      await evalJs("![...document.querySelectorAll('.ml-i')].find(i => i.textContent.includes('院刊 2026')).classList.contains('unread')"), imap.box.msgs.map((m) => m.flags));
    // a PDF attachment opens in a Windose window: drawn, the text selectable, the page count
    await evalJs("[...document.querySelectorAll('.ml-i')].find(i => i.textContent.includes('论文初稿请看')).click()"); await sleep(800);
    await evalJs("document.querySelector('.ml-att').click()");
    for (let i = 0; i < 30 && !(await evalJs("!!document.querySelector('.pdf-page canvas') && !!document.querySelector('.textLayer span')")); i++) await sleep(500);
    chk('PDF attachment: drawn in a Windose window, its text selectable, 2 pages', await evalJs("!!document.querySelector('.pdf-page canvas')") &&
      (await evalJs("document.querySelector('.textLayer').textContent")).includes('Radar cross section') && (await evalJs("document.querySelector('.pdf-bar').textContent")).includes('/ 2 页'),
      await evalJs("(document.querySelector('.viewer')||{}).textContent"));
    chk('the PDF canvas is not blank', await evalJs("(() => { const c = document.querySelector('.pdf-page canvas'); const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data; for (let i = 0; i < d.length; i += 4) if (d[i] < 200) return true; return false; })()"), 0);
    await shot('76-mail-pdf.png');
    await evalJs("[...document.querySelectorAll('.win')].forEach(w => { const t = w.querySelector('.title'); if (t && t.textContent === 'paper.pdf') w.querySelector('.tbtn.close').click(); })"); await sleep(300);
    await evalJs("[...document.querySelectorAll('.ml-i')].find(i => i.textContent.includes('组会改到')).click()"); await sleep(800);
    chk('a message opens in full', (await evalJs("document.querySelector('.ml-view').textContent")).includes('地点 305 会议室'), await evalJs("document.querySelector('.ml-view').textContent.slice(0, 200)"));
    await shot('70-mail.png');
    await evalJs("document.getElementById('mwarn').click()"); await sleep(1200);
    const setTxt = await evalJs("(document.querySelector('.mla')||{}).textContent||''");
    chk('the tray opens 邮箱设置: both mailboxes, the refused one says so, the form, the help', /所里/.test(setTxt) && /登录被拒/.test(setTxt) && /添加邮箱/.test(setTxt) && /客户端专用密码/.test(setTxt), setTxt.slice(0, 300));
    await shot('71-mail-settings.png');
    await evalJs("[...document.querySelectorAll('.win')].forEach(w => { const t = w.querySelector('.title'); if (t && t.textContent === '邮箱设置') w.querySelector('.tbtn.close').click(); })"); await sleep(300);
    // phone
    await call('Emulation.setDeviceMetricsOverride', { width: 390, height: 780, deviceScaleFactor: 2, mobile: true });
    await sleep(1200);
    chk('phone: the list first', await evalJs("getComputedStyle(document.querySelector('.ml-view')).display === 'none' || !document.querySelector('.mail').classList.contains('narrow') || document.querySelector('.mail').classList.contains('reading')"), 0);
    await evalJs("document.querySelector('.mail').classList.remove('reading')"); await sleep(300);
    await shot('72-mail-phone.png');
    await evalJs("document.querySelectorAll('.ml-i')[1].click()"); await sleep(800);
    chk('phone: a message replaces the list, with a way back', await evalJs("document.querySelector('.mail').classList.contains('reading') && getComputedStyle(document.querySelector('.ml-back')).display !== 'none'"), 0);
    await shot('73-mail-phone-read.png');
    ws.close();
  } catch (e) { errors.push('test: ' + e.stack); }
  finally { try { chrome && chrome.kill(); } catch {} srv.kill(); await imap.close(); }
  for (const r of res) console.log(r);
  console.log(errors.length ? 'page errors:\n' + errors.join('\n') : 'no page errors');
  await sleep(800);
  try { fs.rmSync(T, { recursive: true, force: true }); } catch {}
  process.exit(res.some((r) => r.startsWith('FAIL')) || errors.length ? 1 : 0);
})();
