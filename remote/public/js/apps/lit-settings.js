// 控制面板 › 文献 (server/literature/settings.js): the keys of the paper sources, the contact address, and the daily push.
// A key is never shown back -- only whether one is set and its last four characters; leaving the box empty keeps it,
// 清除 removes it. 测试 asks the source once. Everything applies at once (no restart).
import { h } from '../util.js';
import * as net from '../net.js';

export function panel() {
  const root = h('div', { class: 'lset' });
  const msg = h('p', { class: 'gnote' });
  root.append(msg, h('p', { class: 'ghint', text: '文献推送和「画像」的梳理会去 OpenAlex、Semantic Scholar、Crossref 等查文献。key 都不是必须的：不填也能用，填了更稳、额度更高。' }));
  const body = h('div');
  root.append(body);
  let v = null;
  const clear = { s2: false, openalex: false };

  // a key's row: the state, a box for a new one, 清除, 测试
  function keyRow(name, label, link, linkText, note) {
    const k = v.keys[name];
    const box = h('input', { class: 'field', type: 'password', autocomplete: 'off', spellcheck: 'false',
      placeholder: k.set ? `已填写（末 4 位 ${k.tail}${k.fromConfig ? '，来自 config.json' : ''}）：要换就在这里填新的` : '未填写：粘贴 key' });
    const state = h('small', { class: 'lset-st' });
    const test = h('button', { class: 'btn', type: 'button', text: '测试', onclick: async () => {
      state.textContent = '测试中…';
      if (box.value.trim()) { const r = await save(true); if (!r) return; }
      const r = await net.post('/api/lit/settings/test', { which: name });
      state.textContent = r.msg || (r.ok ? '可用' : '不可用'); state.classList.toggle('bad', !r.ok);
    } });
    const del = h('button', { class: 'btn no', type: 'button', text: '清除', disabled: !k.set || k.fromConfig, onclick: () => { clear[name] = true; box.value = ''; box.placeholder = '保存后清除'; } });
    return { box, row: h('div', { class: 'lset-row' }, h('label', { text: label }), h('div', {}, h('div', { class: 'lset-k' }, box, test, del), state,
      h('small', {}, note, ' ', h('a', { href: link, target: '_blank', rel: 'noopener noreferrer', text: linkText })))) };
  }

  let K = {}, F = {};
  async function load() {
    try { v = await (await fetch('/api/lit/settings')).json(); } catch { msg.textContent = '读不到设置（文献模块开着吗？）'; return; }
    if (!v || !v.keys) { msg.textContent = '文献模块没有开启（config.json 里加 "literature"）'; return; }
    K = { s2: keyRow('s2', 'Semantic Scholar', 'https://www.semanticscholar.org/product/api#api-key-form', '申请 key（免费，填表）',
            '检索更准，还能按你收下、星标的文献推荐相似的新论文。不填 key 用公共额度，常常被限流（会自动重试，不行就先跳过）。'),
      openalex: keyRow('openalex', 'OpenAlex', 'https://help.openalex.org/how-to-use-the-api/rate-limits-and-authentication', '关于 key 和额度',
            '推送和梳理的主力检索。不填也能用；填了每天的额度更高。有账号的话：登录 openalex.org，在账号设置里复制 API key 粘到这里。') };
    const num = (val, min, max) => h('input', { class: 'field lset-n', type: 'number', min, max, value: val });
    const colSel = (val) => { const s = h('select', { class: 'field' }, ...[...new Set([val, ...(v.collections || [])])].filter(Boolean).map((n) => h('option', { value: n, text: n }))); s.value = val; return s; };
    F = { mailto: h('input', { class: 'field', type: 'email', value: v.mailto || '', placeholder: '可空：例如你的学校邮箱' }),
      daily: num(v.daily, 0, 5), oldDaily: num(v.oldDaily, 0, 3), visionMaxPages: num(v.visionMaxPages, 0, 200), at: h('input', { class: 'field lset-n', type: 'time', value: v.at }), minScore: num(v.minScore, 1, 10), searchesPerDay: num(v.searchesPerDay, 1, 10),
      reviewCollection: colSel(v.reviewCollection), inboxCollection: h('input', { class: 'field', value: v.inboxCollection }), surveyCollection: h('input', { class: 'field', value: v.surveyCollection }),
      s2Recommend: h('input', { type: 'checkbox', checked: v.s2Recommend }),
      browserPort: num(v.browserPort, 0, 65535), pdfGapSec: num(v.pdfGapSec, 20, 3600), pdfPerDay: num(v.pdfPerDay, 0, 200),
      myloftAccount: h('input', { class: 'field', type: 'email', autocomplete: 'off', value: v.myloftAccount || '', placeholder: '可空：登录 MyLOFT 用的邮箱（不是密码）' }),
      ieeeAccount: h('input', { class: 'field', type: 'email', autocomplete: 'off', value: v.ieeeAccount || '', placeholder: '可空：机构登录用的邮箱（不是密码）' }) };
    const pst = h('small', { class: 'lset-st' });
    const ptest = h('button', { class: 'btn', type: 'button', text: '测试', onclick: async () => { pst.textContent = '测试中…'; if (!(await save(true))) return; const r = await net.post('/api/lit/pdfq/test', {}); pst.textContent = r.msg || (r.ok ? '可用' : '不可用'); pst.classList.toggle('bad', !r.ok); } });
    const row = (label, el, note) => h('div', { class: 'lset-row' }, h('label', { text: label }), h('div', {}, el, note ? h('small', { text: note }) : null));
    body.replaceChildren(
      h('h4', { class: 'aim-h', text: '接口 key' }), K.s2.row, K.openalex.row,
      row('联系邮箱', F.mailto, '会作为联系人告诉 Crossref / OpenAlex / Unpaywall（它们的礼貌约定，回应更快）；Unpaywall 查开放获取 PDF 必须有它。不填就不发送，也不查 Unpaywall。'),
      h('h4', { class: 'aim-h', text: '每日推送' }),
      row('每天最多', h('span', {}, F.daily, ' 篇'), '是上限不是定额：不够格就不推，用复习补位。0 = 只复习。'),
      row('老报告', h('span', {}, F.oldDaily, ' 篇 / 天'), 'NTRS 和 DTIC 的老报告，另算，不占上面的名额；每次拉一页，够格的排队分几天推，用完再往后翻'),
      row('读图', h('span', {}, '不超过 ', F.visionMaxPages, ' 页的整篇读'), '深读时把论文页面当图片给模型逐页转写（公式、表格比文字层准得多，也更费额度）；更长的只在 AI 建议、你批准后读其中几页；0 = 都要批准'),
      row('推送时间', F.at, '工作日这个时间之后推（周六只推老报告，周日不推）'),
      row('分数门槛', h('span', {}, F.minScore, ' 分以上才推（满分 10）'), '推得太杂就调高，常常没有新文献就调低'),
      row('每天检索', h('span', {}, F.searchesPerDay, ' 条检索式（轮流用）')),
      row('相似推荐', h('label', { class: 'lset-cb' }, F.s2Recommend, ' 用 Semantic Scholar 按你收下 / 星标 / 核对过的文献推荐相似的新论文')),
      row('调研文献放进', F.surveyCollection, '梳理问题时调研到、被问题引用的新文献入库到这个分类（按主题分文件夹）；没读过的会优先排进每日阅读'),
      row('复习用的分类', F.reviewCollection, '新文献不够时，从这个分类（含子分类）里挑旧文献复习'),
      row('收下放进', F.inboxCollection, '收下的文献放进 Zotero 的这个分类，按月建子分类'),
      h('h4', { class: 'aim-h', text: '图书馆通道' }),
      h('p', { class: 'ghint', text: '找不到开放获取的 PDF 时，用 Zotero 网页桌面里那个浏览器去下：它登录着所里的图书馆通道（MyLOFT）和出版商的机构账号，下载用的就是你自己的订阅权限。一次一篇，慢慢来；遇到要真人点的验证会停下等你。' }),
      row('浏览器调试端口', h('span', {}, h('span', { class: 'lset-k' }, F.browserPort, ptest), pst), '网页桌面里 Chromium 的调试端口（部署时设的是 9223）；0 = 不用图书馆通道'),
      row('MyLOFT 账号', F.myloftAccount, 'MyLOFT 掉线、连它的网站也要重新登录时，用这个账号自动登录一次：只填账号，密码由那个浏览器自己保存的来填，这里不存也不经手'),
      row('机构登录账号（IEEE、AIP）', F.ieeeAccount, 'IEEE 的登录过期、或 AIP 不给 PDF 时，用这个账号走机构登录（中国科技云通行证）：只填账号，密码由那个浏览器自己保存的来填，这里不存也不经手'),
      row('两篇之间隔', h('span', {}, F.pdfGapSec, ' 秒'), '下完一篇到开始下一篇至少隔这么久（另加一点随机）'),
      row('每天最多', h('span', {}, F.pdfPerDay, ' 篇'), '走图书馆通道的总数；0 = 先不下'),
      h('div', { class: 'gbtns' }, h('button', { class: 'btn go', type: 'button', text: '保存', onclick: () => save(false) })));
  }
  async function save(quiet) {
    const keys = {};
    for (const name of ['s2', 'openalex']) { const t = K[name].box.value.trim(); if (t) keys[name] = t; else if (clear[name]) keys[name] = null; }
    const r = await net.post('/api/lit/settings', { keys, mailto: F.mailto.value, daily: F.daily.value, oldDaily: F.oldDaily.value, visionMaxPages: F.visionMaxPages.value, at: F.at.value, minScore: F.minScore.value, searchesPerDay: F.searchesPerDay.value,
      reviewCollection: F.reviewCollection.value, inboxCollection: F.inboxCollection.value, surveyCollection: F.surveyCollection.value, s2Recommend: F.s2Recommend.checked,
      browserPort: F.browserPort.value, pdfGapSec: F.pdfGapSec.value, pdfPerDay: F.pdfPerDay.value, ieeeAccount: F.ieeeAccount.value, myloftAccount: F.myloftAccount.value });
    msg.textContent = r.ok ? '已保存，马上生效' : r.msg || '没能保存';
    if (r.ok) { clear.s2 = clear.openalex = false; if (!quiet) await load(); }
    return r.ok;
  }
  load();
  return { root };
}
