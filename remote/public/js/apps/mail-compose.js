// 写邮件: one window per draft (remote/server/mail/compose.js keeps it on the NAS; saved a second after you stop
// typing). From (which mailbox), to / cc (/ bcc), subject, the text; the signature and -- for a reply / forward -- the
// original go under it (the original can be left out). 附件 uploads files; a forward has the original's along.
// 「让 GPT 起草」 writes subject and text from a few points (it only fills the editor). 发送 shows what will go where and
// asks for a code if none was entered within the hour; nothing is sent without that.
//   compose({ mode: 'new' | 'reply' | 'all' | 'forward', key?, acc? }), openDraft(id)
import { h } from '../util.js';
import * as wm from '../wm.js';
import * as net from '../net.js';
import { confirmBox, alertBox } from '../dialog.js';

const kb = (n) => (n >= 1048576 ? (n / 1048576).toFixed(1) + ' MB' : Math.max(1, Math.round(n / 1024)) + ' KB');
const pad = (n) => String(n).padStart(2, '0');
const hm = (t) => { const d = new Date(t); return `${pad(d.getHours())}:${pad(d.getMinutes())}`; };
const MODE = { new: '写邮件', reply: '回复', all: '回复全部', forward: '转发' };

export async function compose(o = {}) {
  const r = await net.post('/api/mail/compose/start', o);
  if (!r.ok) { alertBox(r.msg || '没能开始写信', { title: '写邮件', bad: true }); return; }
  show(r.draft);
}
export async function openDraft(id) {
  if (wm.has('mail-compose:' + id)) { wm.open({ id: 'mail-compose:' + id }); return; }
  let d = null; try { const r = await fetch('/api/mail/draft?id=' + encodeURIComponent(id)); if (r.ok) d = await r.json(); } catch {}
  if (d) show(d); else alertBox('这份草稿已经没有了', { title: '草稿' });
}

function show(d) {
  const id = 'mail-compose:' + d.id;
  if (wm.has(id)) { wm.open({ id }); return; }
  let accounts = [];
  const field = (ph, v) => h('input', { class: 'field', placeholder: ph, value: v || '' });
  const from = h('select', { class: 'field' });
  const to = field('收件人（多个用逗号隔开，可以写成 张三 <z@xx.ac.cn>）', d.to), cc = field('抄送', d.cc), bcc = field('密送', d.bcc);
  const subject = field('主题', d.subject);
  const text = h('textarea', { class: 'mc-text', placeholder: '正文' }); text.value = d.text || '';
  const sig = h('pre', { class: 'mc-sig' });
  const quoteOn = h('input', { type: 'checkbox', checked: d.includeQuote !== false });
  const quote = d.quote ? h('details', { class: 'mc-quote' }, h('summary', {}, quoteOn, d.mode === 'forward' ? ' 附上转发的原邮件' : ' 附上原文'), h('pre', { text: d.quote })) : null;
  quoteOn.addEventListener('click', (e) => e.stopPropagation());
  const atts = h('div', { class: 'mc-atts' });
  const status = h('span', { class: 'mc-st' });
  const fileIn = h('input', { type: 'file', multiple: true, hidden: true });
  const bccRow = h('div', { class: 'mc-row', hidden: !d.bcc }, h('b', { text: '密送' }), bcc);
  const aiPoints = h('textarea', { class: 'field mc-points', rows: 3, placeholder: d.mode === 'new' ? '要点：写给谁、想说什么，例如「请李老师帮忙看一下论文第三章，下周三前给意见」' : '要点（可不写，让它看原邮件写一封合适的回复），例如「同意参加，但周四下午有课，问能不能改到周五」' });
  const aiTone = h('select', { class: 'field' }, h('option', { value: 'formal', text: '正式礼貌' }), h('option', { value: 'brief', text: '简洁直接' }), h('option', { value: 'casual', text: '轻松随和' }));
  const aiBtn = h('button', { class: 'btn go', type: 'button', text: '起草' });
  const ai = h('div', { class: 'mc-ai', hidden: true }, h('b', { text: '让 GPT 起草（只是写进编辑框，不会替你发出）' }), aiPoints, h('div', { class: 'mc-row' }, h('span', { text: '语气' }), aiTone, aiBtn));
  const sendBtn = h('button', { class: 'btn go', type: 'button', text: '发送' });
  const root = h('div', { class: 'mcomp' },
    h('div', { class: 'mc-bar' }, sendBtn,
      h('button', { class: 'btn', type: 'button', text: '让 GPT 起草', onclick: () => { ai.hidden = !ai.hidden; if (!ai.hidden) aiPoints.focus(); } }),
      h('button', { class: 'btn', type: 'button', text: '附件…', onclick: () => fileIn.click() }),
      h('button', { class: 'btn', type: 'button', text: '密送', onclick: () => { bccRow.hidden = false; bcc.focus(); } }),
      h('button', { class: 'btn', type: 'button', text: '删除草稿', onclick: drop }), status, fileIn),
    h('div', { class: 'mc-body' }, ai,
      h('div', { class: 'mc-row' }, h('b', { text: '发件' }), from),
      h('div', { class: 'mc-row' }, h('b', { text: '收件人' }), to),
      h('div', { class: 'mc-row' }, h('b', { text: '抄送' }), cc), bccRow,
      h('div', { class: 'mc-row' }, h('b', { text: '主题' }), subject),
      atts, text, sig, quote));
  wm.open({ id, title: `${MODE[d.mode] || '写邮件'}：${d.subject || '（无主题）'}`, icon: '/icons/outlook_express-16.png', content: root, width: 720, height: 620,
    onClose: () => { flush(); } });

  // the mailboxes to send from, and their signatures
  (async () => {
    try { accounts = (await (await fetch('/api/mail')).json()).accounts || []; } catch {}
    from.replaceChildren(...accounts.map((a) => h('option', { value: a.id, text: `${a.name} <${a.address}>` })));
    from.value = d.acc; showSig();
  })();
  function showSig() { const a = accounts.find((x) => x.id === from.value); sig.textContent = a && a.signature ? '-- \n' + a.signature : ''; sig.hidden = !sig.textContent; }
  function showAtts() {
    atts.replaceChildren(...(d.atts || []).map((a) => h('span', { class: 'mc-att', title: a.src === 'orig' ? '原邮件的附件，发送时从邮箱取' : '' }, `📎 ${a.name}（${kb(a.size || 0)}）`,
      h('button', { class: 'mc-x', type: 'button', text: '×', title: '去掉', onclick: async () => {
        const r = await net.post('/api/mail/drafts/att-remove', { id: d.id, att: a.id });
        if (r.ok) { d.atts = d.atts.filter((x) => x !== a); showAtts(); }
      } }))));
  }
  showAtts(); showSig();

  // saved a second after typing stops
  let t = null, dirty = false;
  const say = (s, bad) => { status.textContent = s; status.classList.toggle('bad', !!bad); };
  async function flush() {
    clearTimeout(t);
    if (!dirty) return true;
    dirty = false;
    const r = await net.post('/api/mail/drafts/save', { id: d.id, acc: from.value || d.acc, to: to.value, cc: cc.value, bcc: bcc.value, subject: subject.value, text: text.value, includeQuote: quoteOn.checked });
    if (!r.ok) { say(r.msg || '没能保存', true); return false; }
    say('已保存 ' + hm(r.updated));
    return true;
  }
  const edited = () => { dirty = true; say('…'); clearTimeout(t); t = setTimeout(flush, 1000); };
  for (const el of [to, cc, bcc, subject, text]) el.addEventListener('input', edited);
  from.addEventListener('change', () => { showSig(); edited(); });
  quoteOn.addEventListener('change', edited);

  fileIn.addEventListener('change', async () => {
    for (const f of fileIn.files) {
      say(`上传 ${f.name}…`);
      let r = {};
      try { r = await (await fetch(`/api/mail/upload?draft=${encodeURIComponent(d.id)}&name=${encodeURIComponent(f.name)}&type=${encodeURIComponent(f.type || '')}`, { method: 'POST', body: f })).json(); } catch {}
      if (!r.ok) { say(r.msg || `${f.name} 没能上传`, true); break; }
      d.atts = [...(d.atts || []), r.att]; showAtts(); say('');
    }
    fileIn.value = '';
  });

  aiBtn.addEventListener('click', async () => {
    await flush();
    aiBtn.disabled = true; say('GPT 正在起草…（要一会儿）');
    const r = await net.post('/api/mail/compose/ai', { id: d.id, points: aiPoints.value, tone: aiTone.value });
    aiBtn.disabled = false;
    if (!r.ok) return say(r.msg || '没能起草', true);
    if (text.value.trim() && !(await confirmBox('用 GPT 写的替换现在的正文？', { title: '让 GPT 起草', ok: '替换' }))) return say('');
    text.value = r.text;
    if (!subject.value.trim() || d.mode === 'new') subject.value = r.subject;
    ai.hidden = true; edited(); say('GPT 起草好了，看一下、改一改再发');
  });

  async function drop() {
    if (!(await confirmBox('删除这份草稿？', { title: '删除草稿', ok: '删除', danger: true }))) return;
    await net.post('/api/mail/drafts/delete', { id: d.id });
    dirty = false; wm.close(id);
  }

  sendBtn.addEventListener('click', async () => {
    if (!(await flush())) return;
    const a = accounts.find((x) => x.id === from.value);
    const lines = [`从：${a ? a.address : ''}`, `给：${to.value || '（没填）'}`, cc.value ? `抄送：${cc.value}` : '', bcc.value ? `密送：${bcc.value}` : '',
      `主题：${subject.value || '（没填）'}`, (d.atts || []).length ? `附件：${d.atts.map((x) => x.name).join('、')}` : '', quote && quoteOn.checked ? '（附上原文）' : ''].filter(Boolean);
    if (!(await confirmBox('发送这封邮件？\n\n' + lines.join('\n'), { title: '发送邮件', ok: '发送' }))) return;
    sendBtn.disabled = true; say('发送中…');
    const r = await net.post('/api/mail/send', { id: d.id });
    sendBtn.disabled = false;
    if (!r.ok) return say(r.msg || '没有发出去', true);
    dirty = false;
    wm.close(id);
    const notes = (r.notes || []).join('；');
    alertBox('已发出' + (r.saved ? '，副本存进了「已发送」' : '') + (r.answered ? '，原邮件标为已回复' : '') + (notes ? '。\n' + notes : '。'), { title: '邮件已发出' });
  });
}
