// Writing mail: 写信 / 回复 / 回复全部 / 转发 start a draft (drafts.js) filled in from the mail answered -- who to, Re: /
// Fwd:, the original quoted under it, In-Reply-To / References so it stays one thread; a forward takes the original's
// attachments along (fetched from the mailbox when it is sent). 「让 GPT 起草」 writes the text from your points
// (compose-prompt.js) into the editor; nothing is sent by the model. 发送 (a code entered within the hour, like remote
// control) checks the addresses, at most 50 recipients and 20 mails an hour, then sends (send.js): the copy in the
// sent folder, the original marked answered; the draft and its files are gone afterwards. The audit log keeps who to
// and the subject, not the text.
//   GET  /api/mail/drafts, /api/mail/draft?id=
//   POST /api/mail/compose/start { mode, key?, acc? } -> a new draft;  /api/mail/drafts/save {...};  .../delete { id }
//   POST /api/mail/upload?draft=&name=&type= (the file as the body);  /api/mail/drafts/att-remove { id, att }
//   POST /api/mail/compose/ai { id, points, tone } -> { subject, text };  /api/mail/send { id }
'use strict';
const addressparser = require('nodemailer/lib/addressparser');
const { createDrafts } = require('./drafts');
const { sendMail } = require('./send');
const { fetchAttachment } = require('./attach');
const { DRAFT_SCHEMA, draftPrompt } = require('./compose-prompt');

const MAX_RCPT = 50, PER_HOUR = 20, QUOTE_LINES = 300;
const ADDRESS = /^[^\s@<>"]{1,64}@[A-Za-z0-9.-]{1,190}\.[A-Za-z]{2,}$/;
const pad = (n) => String(n).padStart(2, '0');
const when = (t) => { const d = new Date(t); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`; };
const who = (a) => (a ? (a.name ? `${a.name} <${a.address}>` : a.address) : '');
// the addresses as typed: split at , ; ，； (not inside quotes or <>), each piece read on its own -- the parser alone
// would take a word without @ for the next address's name ("nobody, 王 <w@x.cn>" is one address) and drop it quietly
function parseList(s) {
  const parts = [];
  let cur = '', q = false, angle = 0;
  for (const ch of String(s || '')) {
    if (ch === '"') q = !q;
    else if (!q && ch === '<') angle++;
    else if (!q && ch === '>') angle = Math.max(0, angle - 1);
    if (!q && !angle && /[,;，；\n]/.test(ch)) { parts.push(cur); cur = ''; } else cur += ch;
  }
  parts.push(cur);
  return parts.map((p) => p.trim()).filter(Boolean).map((p) => {
    const a = (addressparser.default || addressparser)(p).flatMap((x) => (x.group ? x.group : [x]))[0] || {};
    return { name: a.name || '', address: a.address || '', typed: p };
  });
}

function createCompose({ dataDir, accounts, store, ask = null, log = () => {}, audit = () => {}, client, transport }) {
  const drafts = createDrafts({ dataDir });
  const sentAt = [];                                    // send times, for the hourly limit

  // a new draft: { mode, key (the mail answered / forwarded), acc }
  function start({ mode = 'new', key = '', acc = '' }) {
    const m = mode !== 'new' && key ? store.get(String(key)) : null;
    if (mode !== 'new' && !m) return { ok: false, msg: '找不到这封邮件' };
    const a = accounts.get(m ? m.acc : acc) || accounts.all()[0];
    if (!a) return { ok: false, msg: '还没有邮箱：先在「设置」里添加' };
    const d = { acc: a.id, mode, ref: m ? m.key : '', includeQuote: true };
    if (m) {
      const subj = String(m.subject || '');
      const head = `在 ${when(m.date)}，${who(m.from)} 写道：`;
      if (mode === 'forward') {
        d.subject = /^(fwd?|转发)[:：]/i.test(subj) ? subj : 'Fwd: ' + subj;
        d.quote = ['---------- 转发的邮件 ----------', `发件人：${who(m.from)}`, `时间：${when(m.date)}`, `主题：${subj}`,
          `收件人：${(m.to || []).map(who).join('，')}`, m.cc && m.cc.length ? `抄送：${m.cc.map(who).join('，')}` : '', '', m.text || ''].filter((x, i) => x || i > 5).join('\n');
        d.atts = (m.att || []).map((x, i) => ({ id: 'orig' + i, name: x.name, size: x.size, type: x.type, src: 'orig', i }));
      } else {
        const me = a.address.toLowerCase();
        const to = [m.replyTo && m.replyTo.address ? m.replyTo : m.from].filter((x) => x && x.address);
        d.to = to.map(who).join(', ');
        if (mode === 'all') {
          const seen = new Set([me, ...to.map((x) => x.address.toLowerCase())]);
          d.cc = [...(m.to || []), ...(m.cc || [])].filter((x) => x.address && !seen.has(x.address.toLowerCase()) && seen.add(x.address.toLowerCase())).map(who).join(', ');
        }
        d.subject = /^(re|回复|答复)[:：]/i.test(subj) ? subj : 'Re: ' + subj;
        const lines = String(m.text || '').split('\n');
        d.quote = [head, ...lines.slice(0, QUOTE_LINES).map((l) => '> ' + l), lines.length > QUOTE_LINES ? '> ……' : ''].filter((x, i, arr) => x || i < arr.length - 1).join('\n');
        d.inReplyTo = m.mid || '';
        d.references = [...(m.refs || []), m.mid].filter(Boolean);
      }
    }
    return { ok: true, draft: drafts.create(d) };
  }

  // the draft as the editor shows it (+ the signature the mailbox adds)
  const view = (x) => { const a = accounts.get(x.acc); return { ...x, signature: a ? a.signature || '' : '', from: a ? who({ name: a.name, address: a.address }) : '' }; };

  async function draftWithAi(d) {
    if (!ask) return { ok: false, msg: '工作日报没有开启，没有模型可以起草' };
    const x = drafts.get(String(d.id || ''));
    if (!x) return { ok: false, msg: '这份草稿已经没有了' };
    const a = accounts.get(x.acc), m = x.ref ? store.get(x.ref) : null;
    const prompt = draftPrompt({ mode: x.mode, points: String(d.points || '').slice(0, 2000), tone: d.tone, subject: x.subject, text: x.text, to: x.to,
      orig: m ? { from: who(m.from), date: when(m.date), subject: m.subject, text: m.text } : null, me: { name: a ? a.name : '', address: a ? a.address : '' } });
    try {
      const r = await ask(prompt, DRAFT_SCHEMA, 'mailDraft');
      return { ok: true, subject: String(r.subject || x.subject || '').slice(0, 500), text: String(r.text || '').slice(0, 50000) };
    } catch (e) { return { ok: false, msg: '模型没能起草：' + e.message }; }
  }

  // 发送: checks first, then out; -> { ok, msg?, saved, answered, notes }
  async function send(id, ip) {
    const x = drafts.get(String(id || ''));
    if (!x) return { ok: false, msg: '这份草稿已经没有了' };
    const a = accounts.get(x.acc);
    if (!a) return { ok: false, msg: '发件邮箱已经删掉了' };
    const to = parseList(x.to), cc = parseList(x.cc), bcc = parseList(x.bcc), all = [...to, ...cc, ...bcc];
    const bad = all.filter((r) => !ADDRESS.test(r.address || ''));
    if (!to.length) return { ok: false, msg: '请填收件人' };
    if (bad.length) return { ok: false, msg: '这些地址不对：' + bad.map((r) => r.typed).join('、') };
    if (all.length > MAX_RCPT) return { ok: false, msg: `收件人太多（最多 ${MAX_RCPT} 个）` };
    if (!x.subject.trim()) return { ok: false, msg: '请填主题' };
    while (sentAt.length && Date.now() - sentAt[0] > 3600e3) sentAt.shift();
    if (sentAt.length >= PER_HOUR) return { ok: false, msg: `一小时内最多发 ${PER_HOUR} 封，稍后再发` };
    const m = x.ref ? store.get(x.ref) : null;
    // the attachments: yours from the NAS, a forward's from the mailbox
    const attachments = [];
    try {
      for (const t of x.atts) {
        if (t.src === 'upload') attachments.push({ filename: t.name, content: drafts.readUpload(t.id), contentType: t.type });
        else if (t.src === 'orig' && m) {
          const got = await fetchAttachment({ account: accounts.get(m.acc), uid: m.uid, i: t.i, name: t.name, client });
          const bufs = []; for await (const c of got.stream) bufs.push(c); got.close();
          attachments.push({ filename: got.name || t.name, content: Buffer.concat(bufs), contentType: got.type });
        }
      }
    } catch (e) { return { ok: false, msg: '附件没能准备好：' + e.message }; }
    if (attachments.reduce((n, t) => n + t.content.length, 0) > drafts.TOTAL_MAX) return { ok: false, msg: '附件合计超过 25 MB' };
    const text = [x.text.replace(/\s+$/, ''), a.signature ? '\n-- \n' + a.signature : '', x.includeQuote && x.quote ? '\n' + x.quote : ''].filter(Boolean).join('\n');
    const answer = m && (x.mode === 'reply' || x.mode === 'all') && m.acc === a.id ? { uid: m.uid, uv: m.key.split(':')[1] } : null;
    let r;
    const clean = (l) => l.map(({ name, address }) => ({ name, address }));
    try { r = await sendMail({ account: a, mail: { to: clean(to), cc: clean(cc), bcc: clean(bcc), subject: x.subject, text, inReplyTo: x.inReplyTo, references: x.references, attachments }, answer, transport, client }); }
    catch (e) { return { ok: false, msg: '没有发出去：' + (e.response || e.message) }; }
    sentAt.push(Date.now());
    drafts.remove(x.id);
    audit('mail-send', ip, `${a.address} -> ${all.map((y) => y.address).join(',')} | ${x.subject}`.slice(0, 400));
    log(`邮件：${a.address} 发出「${x.subject}」给 ${all.length} 人`);
    return { ok: true, saved: r.saved, answered: r.answered, notes: r.notes };
  }

  async function handle(req, res, url, ip, json, readBody, fresh) {
    const p = url.pathname;
    if (req.method === 'GET' && p === '/api/mail/drafts') {
      json(res, 200, { items: drafts.list().map((x) => ({ id: x.id, acc: x.acc, mode: x.mode, to: x.to, subject: x.subject, updated: x.updated })) });
      return true;
    }
    if (req.method === 'GET' && p === '/api/mail/draft') { const x = drafts.get(String(url.searchParams.get('id') || '')); json(res, x ? 200 : 404, x ? view(x) : { error: 'not found' }); return true; }
    if (req.method !== 'POST') return false;
    if (p === '/api/mail/upload') {
      const r = await drafts.upload(String(url.searchParams.get('draft') || ''), String(url.searchParams.get('name') || ''), String(url.searchParams.get('type') || ''), req);
      json(res, 200, r); return true;
    }
    const routes = ['/api/mail/compose/start', '/api/mail/drafts/save', '/api/mail/drafts/delete', '/api/mail/drafts/att-remove', '/api/mail/compose/ai', '/api/mail/send'];
    if (!routes.includes(p)) return false;
    let d = {}; try { d = JSON.parse(await readBody(req, 600000)); } catch {}
    let r;
    if (p === '/api/mail/compose/start') { r = start(d); if (r.ok) r.draft = view(r.draft); }
    else if (p === '/api/mail/drafts/save') r = drafts.update(d);
    else if (p === '/api/mail/drafts/delete') r = drafts.remove(String(d.id || ''));
    else if (p === '/api/mail/drafts/att-remove') r = drafts.removeAtt(String(d.id || ''), String(d.att || ''));
    else if (p === '/api/mail/compose/ai') r = await draftWithAi(d);
    else if (p === '/api/mail/send') r = fresh() ? await send(d.id, ip) : { ok: false, need: 'totp', msg: '需要再输一次验证码' };
    json(res, 200, r);
    return true;
  }

  return { handle, start, send, draftWithAi, drafts };
}

module.exports = { createCompose, parseList };
