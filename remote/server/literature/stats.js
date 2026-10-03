// 阅读产出: not how much was read but what reading turned into, over the last N days -- cards checked, understanding
// written before reading, findings kept from the talks (accepted proposals), actions taken into 重要计划 and done,
// topic pages updated -- next to what the push brought (kept / skipped / reviewed). A week with reading but no output
// says so (the window shows it, the weekly report can quote it).
'use strict';
const fs = require('fs');
const path = require('path');

const ymd = (t) => { const d = new Date(t); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };

function createStats({ kb, feed, todos = null }) {
  function range(days = 7) {
    const from = ymd(Date.now() - (days - 1) * 86400e3), since = Date.parse(from + 'T00:00:00');
    let log = []; try { log = fs.readFileSync(path.join(kb.dir, 'log.md'), 'utf8').split('\n').map((l) => /^- (\d{4}-\d{2}-\d{2}) (.*)$/.exec(l)).filter((m) => m && m[1] >= from).map((m) => m[2]); } catch {}
    const count = (re) => log.filter((l) => re.test(l)).length;
    const papers = kb.list('papers').filter((r) => String(r.meta.updated || '') >= from);
    const es = feed.entries().filter((e) => (e.decidedAt || e.created) >= since);
    const acts = todos ? todos.list().filter((t) => t.project === '文献') : [];
    const out = {
      from, days,
      cards: { quick: papers.filter((r) => r.meta.status === 'quick').length, deep: papers.filter((r) => r.meta.status === 'deep' || r.meta.status === 'reviewed').length, verified: count(/^核对了卡片/) },
      understanding: count(/^写下理解/), kept: count(/^接受建议/), topics: count(/^接受建议：专题/) + count(/^新专题/),
      actions: { added: acts.filter((t) => t.created >= since).length, done: acts.filter((t) => t.done && (t.doneAt || 0) >= since).length },
      feed: { pushed: es.filter((e) => e.created >= since && e.status !== 'spare').length, kept: es.filter((e) => e.status === 'kept').length, skipped: es.filter((e) => e.status === 'skipped').length, reviewed: es.filter((e) => e.status === 'done').length },
    };
    const output = out.cards.verified + out.understanding + out.kept + out.actions.done + out.topics;
    const input = out.cards.quick + out.cards.deep + out.feed.kept + out.feed.reviewed;
    out.verdict = !input ? '这段时间还没有阅读。' : !output ? '读了，但还没有产出：试试核对一张卡片、写下理解，或把一个行动做完。' : `读的 ${input} 项里有 ${output} 项变成了产出。`;
    return out;
  }
  return { range };
}

module.exports = { createStats };
