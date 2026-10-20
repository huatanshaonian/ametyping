// The subagents a Claude Code session started (s.agents: the agent reads their own transcripts, agent/subagents.js):
// a line over the conversation -- how many are running, finished, stopped -- that opens into one row per agent:
// its type, what it was asked, what it is doing now, for how long.
import { h, ago, prefs } from '../util.js';

const STATE = { run: '运行中', done: '已完成', stop: '已中断' };

// how long, in words: 42秒 / 5分 / 1小时20分
function span(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}秒`;
  if (s < 3600) return `${Math.floor(s / 60)}分`;
  const m = Math.floor(s / 60) % 60;
  return `${Math.floor(s / 3600)}小时${m ? m + '分' : ''}`;
}

// "agent 3" on a session's card while some are running (the title lists them)
export function agentTag(s) {
  const a = s.agents || [], run = a.filter((x) => x.state === 'run');
  if (!run.length) return null;
  return { text: `agent ${run.length}`, title: '正在运行的子 agent：\n' + run.map((x) => `· ${x.name || x.type}：${x.desc}`).join('\n') };
}

export function createAgents() {
  let open = prefs.get('dash.agentsOpen', false);
  const sum = h('button', { class: 'ag-sum', type: 'button' });
  const rows = h('div', { class: 'ag-rows' });
  const el = h('div', { class: 'agents', hidden: true }, sum, rows);
  let cur = null;
  sum.addEventListener('click', () => { open = !open; prefs.set('dash.agentsOpen', open); render(cur); });

  function row(a, now) {
    const who = a.name && a.name !== a.type ? `${a.type} · ${a.name}` : a.type;
    const when = a.state === 'run' ? `已运行 ${span(now - a.t0)}`
      : `${STATE[a.state]} · 用时 ${span((a.end || a.last) - a.t0)} · ${ago(a.end || a.last)}`;
    return h('div', { class: 'ag ' + a.state },
      h('span', { class: 'ag-dot', title: STATE[a.state] }),
      h('div', { class: 'ag-main' },
        h('div', { class: 'ag-l1' }, h('b', { text: a.desc || who }), a.bg ? h('span', { class: 'ag-bg', text: '后台' }) : null),
        h('div', { class: 'ag-l2', text: [who, a.state !== 'done' ? a.act : '', when].filter(Boolean).join(' · '), title: a.act || '' })));
  }

  function render(s) {
    cur = s;
    const a = (s && s.agents) || [];
    el.hidden = !a.length;
    if (!a.length) { rows.replaceChildren(); return; }
    const n = (k) => a.filter((x) => x.state === k).length;
    const parts = [n('run') && `${n('run')} 个运行中`, n('done') && `${n('done')} 个已完成`, n('stop') && `${n('stop')} 个已中断`].filter(Boolean);
    sum.textContent = `${open ? '▾' : '▸'} 子 agent · ${parts.join(' · ')}`;
    sum.classList.toggle('busy', n('run') > 0);
    rows.hidden = !open;
    if (open) { const now = Date.now(); rows.replaceChildren(...a.map((x) => row(x, now))); }
  }
  // the running times move on without news from the machine
  setInterval(() => { if (cur && open && el.isConnected && !el.hidden) render(cur); }, 15e3);
  return { el, render };
}
