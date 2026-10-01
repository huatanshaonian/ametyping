// The mail kept on the NAS: <dataDir>/mail/<account id>/<YYYY-MM>.jsonl, one message per line (parse.js's record plus
// key = "<account>:<uidvalidity>:<uid>", acc, uid). In memory: every message without its text (the list, the daily
// digest's selection); the text is read from its month's file when a message is opened.
'use strict';
const fs = require('fs');
const path = require('path');

const pad = (n) => String(n).padStart(2, '0');
const monthOf = (t) => { const d = new Date(t); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}`; };

function createMailStore({ dataDir }) {
  const root = path.join(dataDir, 'mail');
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  const index = new Map();                            // key -> the message without text
  const byMid = new Map();                            // "<acc>|<Message-ID>" -> key (the same message seen twice)
  const head = (r) => { const { text, ...rest } = r; return { ...rest, snippet: String(text || '').replace(/\s+/g, ' ').trim().slice(0, 160) }; };

  for (const acc of fs.readdirSync(root)) {
    let files = []; try { files = fs.readdirSync(path.join(root, acc)).filter((f) => /^\d{4}-\d{2}\.jsonl$/.test(f)); } catch {}
    for (const f of files) {
      for (const line of fs.readFileSync(path.join(root, acc, f), 'utf8').split('\n')) {
        if (!line) continue;
        try { const r = JSON.parse(line); index.set(r.key, head(r)); if (r.mid) byMid.set(acc + '|' + r.mid, r.key); } catch {}
      }
    }
  }

  const has = (key) => index.has(key);
  // r: parse.js's record + { key, acc, uid }; false when it is already there
  function add(r) {
    if (index.has(r.key) || (r.mid && byMid.has(r.acc + '|' + r.mid))) return false;
    const dir = path.join(root, r.acc);
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    fs.appendFileSync(path.join(dir, monthOf(r.date) + '.jsonl'), JSON.stringify(r) + '\n', { mode: 0o600 });
    index.set(r.key, head(r));
    if (r.mid) byMid.set(r.acc + '|' + r.mid, r.key);
    return true;
  }
  // the whole message (with its text)
  function get(key) {
    const h = index.get(key);
    if (!h) return null;
    const want = '{"key":' + JSON.stringify(key) + ',';
    let lines = []; try { lines = fs.readFileSync(path.join(root, h.acc, monthOf(h.date) + '.jsonl'), 'utf8').split('\n'); } catch {}
    const line = lines.find((l) => l.startsWith(want));
    try { return line ? JSON.parse(line) : { ...h, text: '' }; } catch { return { ...h, text: '' }; }
  }
  // newest first; { acc, before (date ms), limit, filter(head) }
  function list({ acc = '', before = Infinity, limit = 50, filter = null } = {}) {
    const out = [];
    for (const h of index.values()) if ((!acc || h.acc === acc) && h.date < before && (!filter || filter(h))) out.push(h);
    out.sort((a, b) => b.date - a.date);
    return out.slice(0, limit);
  }
  // [from, to): the daily digest's messages
  const between = (from, to) => [...index.values()].filter((h) => h.date >= from && h.date < to).sort((a, b) => a.date - b.date);
  const count = (acc) => { let n = 0; for (const h of index.values()) if (h.acc === acc) n++; return n; };
  function removeAccount(acc) {
    for (const [k, h] of index) if (h.acc === acc) { index.delete(k); if (h.mid) byMid.delete(acc + '|' + h.mid); }
    try { fs.rmSync(path.join(root, acc), { recursive: true, force: true }); } catch {}
  }

  return { has, add, get, list, between, count, removeAccount };
}

module.exports = { createMailStore };
