// One AI tool on the NAS in AI 模型 (remote/server/ai/cli-admin.js): Codex or Claude Code -- its version, the newest
// release (looked up every 5 days; 「现在检查」 asks now), 「更新」 (asks for a code), whether it is logged in.
import { h } from '../util.js';
import * as net from '../net.js';
import { confirmBox, alertBox } from '../dialog.js';

const pad = (n) => String(n).padStart(2, '0');
export const when = (t) => { const d = new Date(t); return `${d.getMonth() + 1} 月 ${d.getDate()} 日 ${pad(d.getHours())}:${pad(d.getMinutes())}`; };
const TOOLS = {
  codex: { label: 'Codex', login: (l) => (l.mode ? '（' + (l.mode === 'chatgpt' ? 'ChatGPT 账号' : l.mode) + '）' : '') + (l.refreshed ? '，' + when(Date.parse(l.refreshed)) + ' 刷新过' : '') },
  claude: { label: 'Claude Code', login: (l) => (l.mode ? '（' + (l.mode === 'claude.ai' ? 'Claude 账号' : l.mode) + (l.plan ? ' · ' + l.plan[0].toUpperCase() + l.plan.slice(1) + ' 订阅' : '') + '）' : '') },
};

// name: 'codex' | 'claude'
export function cliBox(name) {
  const t = TOOLS[name];
  const root = h('div', { class: 'aim-codex aim-cli', dataset: { tool: name } });
  let pollT = null;
  async function load(check) {
    root.replaceChildren(h('p', { class: 'ghint', text: check ? '正在查最新版本…' : '读取中…' }));
    let c = {}; try { c = await (await fetch(`/api/ai/${name}` + (check ? '?check=1' : ''))).json(); } catch {}
    const newer = c.latest && c.version && c.latest !== c.version;
    const lu = c.lastUpdate, l = c.login;
    root.replaceChildren(...[
      h('div', { class: 'aim-kv' }, h('b', { text: '当前版本' }), h('span', { text: c.version || '（读不到）' })),
      h('div', { class: 'aim-kv' }, h('b', { text: '最新版本' }), h('span', { class: newer ? 'aim-new' : '',
        text: c.latest ? `${c.latest}${newer ? '（有新版本）' : '（已是最新）'}` : c.latestError ? '没查到：' + c.latestError : '还没查过' }),
        h('small', { text: c.checkedAt ? `  ${when(c.checkedAt)} 查的，每 5 天自动查一次` : '  每 5 天自动查一次' })),
      h('div', { class: 'aim-kv' }, h('b', { text: '登录' }), h('span', { class: l && l.ok ? '' : 'aim-bad',
        text: l ? `${l.ok ? '已登录' : '没登录'}${t.login(l)}` : '' })),
      c.updating ? h('p', { class: 'gnote', text: `正在更新 ${t.label}…（几分钟）` }) : null,
      lu ? h('p', { class: 'ghint' + (lu.ok ? '' : ' bad'), text: `上次更新：${when(lu.at)}，${lu.ok ? `${lu.from} → ${lu.to}` : '失败'}` }) : null,
      lu && !lu.ok && lu.out ? h('pre', { class: 'aim-out', text: lu.out }) : null,
      h('div', { class: 'gbtns' },
        h('button', { class: 'btn', type: 'button', text: '现在检查', onclick: () => load(true) }),
        h('button', { class: 'btn' + (newer ? ' go' : ''), type: 'button', text: `更新 ${t.label}`, disabled: !!c.updating, onclick: async () => {
          if (!(await confirmBox(`现在更新群晖上的 ${t.label}？\n（正在进行的任务会用旧版本做完）`, { title: `更新 ${t.label}`, ok: '更新' }))) return;
          const r = await net.post(`/api/ai/${name}/update`, {});
          if (!r.ok) return alertBox(r.msg || '没能开始更新', { title: `更新 ${t.label}`, bad: true });
          load(false); poll();
        } }))].filter(Boolean));                                  // (replaceChildren would print null)
  }
  function poll() { clearTimeout(pollT); pollT = setTimeout(async () => { let c = {}; try { c = await (await fetch(`/api/ai/${name}`)).json(); } catch {} if (c.updating) poll(); else load(false); }, 5000); }
  load(false);
  return { root, destroy() { clearTimeout(pollT); } };
}
