// One conversation as a file to keep or pass on (糖糖看板's 导出): everything the store has of it, oldest first --
// what you said and the replies in full, tool calls one line each (their output never reaches the NAS anyway).
//   md: a heading, a details list (machine, folder, time, how to resume), then the conversation by day
//   txt: the same as plain text
'use strict';

const pad = (n) => String(n).padStart(2, '0');
const WEEK = '日一二三四五六';
const ymd = (t) => { const d = new Date(t); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };
const hm = (t) => { const d = new Date(t); return `${pad(d.getHours())}:${pad(d.getMinutes())}`; };
const dayTitle = (t) => { const d = new Date(t); return `${d.getFullYear()} 年 ${d.getMonth() + 1} 月 ${d.getDate()} 日 周${WEEK[d.getDay()]}`; };

// the store's records -> messages: a reply streamed in parts is one, consecutive tool calls one group
function messagesOf(recs) {
  const out = [];
  for (const r of recs) {
    if (r.role === 'title' || r.role === 'mode' || r.role === 'ctx') continue;
    const last = out[out.length - 1];
    if (r.role === 'assistant' && last && last.role === 'assistant' && r.mid && last.mid === r.mid) last.text += '\n\n' + r.text;
    else if (r.role === 'tool' && last && last.role === 'tool') last.items.push(...(r.items || []));
    else out.push({ role: r.role, text: r.text || '', items: [...(r.items || [])], t: r.t, mid: r.mid });
  }
  return out;
}

function createExport({ store, resumeCmd }) {
  // -> { name, type, body } or null when the store does not know the session
  function build(machine, id, fmt) {
    const e = (store.sessions()[machine] || []).find((x) => x.id === id);
    if (!e) return null;
    const msgs = messagesOf(store.records(machine, id, 0, Date.now() + 86400e3));
    const title = e.title || e.project || id.slice(0, 8);
    const bot = id.startsWith('codex:') ? 'Codex' : 'Claude';
    const resume = resumeCmd ? resumeCmd(e.cwd, id) : '';
    const first = msgs.length ? msgs[0].t : e.first, last = msgs.length ? msgs[msgs.length - 1].t : e.last;
    const span = first ? `${ymd(first)} ${hm(first)} – ${ymd(last)} ${hm(last)}` : '';
    const md = fmt !== 'txt';
    const lines = [];
    if (md) {
      lines.push(`# ${title}`, '', `- 电脑：${machine}`, `- 项目：${e.project || '—'}${e.cwd ? `（${e.cwd}）` : ''}`, span ? `- 时间：${span}` : null,
        resume ? `- 继续：\`${resume}\`` : null, `- 会话：${id}`, `- 导出于：${ymd(Date.now())} ${hm(Date.now())}（Windose 糖糖看板）`, '');
    } else {
      lines.push(title, `电脑：${machine}`, `项目：${e.project || '—'}${e.cwd ? `（${e.cwd}）` : ''}`, span ? `时间：${span}` : null,
        resume ? `继续：${resume}` : null, `会话：${id}`, `导出于：${ymd(Date.now())} ${hm(Date.now())}（Windose 糖糖看板）`, '');
    }
    let day = '';
    for (const m of msgs) {
      if (ymd(m.t) !== day) { day = ymd(m.t); lines.push(md ? `## ${dayTitle(m.t)}` : `==== ${dayTitle(m.t)} ====`, ''); }
      if (m.role === 'tool') { lines.push(md ? `> 工具（${hm(m.t)}）：${m.items.join(' · ')}` : `  · 工具（${hm(m.t)}）：${m.items.join(' · ')}`, ''); continue; }
      if (m.role === 'sys') { lines.push(md ? `*（${m.text}）*` : `（${m.text}）`, ''); continue; }
      const who = m.role === 'user' ? '我' : bot;
      lines.push(md ? `### ${who} · ${hm(m.t)}` : `[${hm(m.t)}] ${who}：`, '', m.text, '');
    }
    if (!msgs.length) lines.push('（这个会话还没有存下内容）');
    const safe = title.replace(/[\\/:*?"<>|\r\n\t]+/g, ' ').trim().slice(0, 60) || 'conversation';
    return { name: `${safe} ${ymd(first || Date.now())}.${md ? 'md' : 'txt'}`, type: (md ? 'text/markdown' : 'text/plain') + '; charset=utf-8',
      body: lines.filter((l) => l != null).join('\n') };
  }
  return { build };
}

module.exports = { createExport, messagesOf };
