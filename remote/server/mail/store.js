// The mail kept on the NAS: <dataDir>/mail/<account id>/<YYYY-MM>.jsonl, one message per line (parse.js's record plus
// key = "<account>:<uidvalidity>:<uid>", acc, uid). In memory: every message without its text (the list, the daily
// digest's selection); the text is read from its month's file when a message is opened.
//   - read / unread: as the mailbox has it (imap.js keeps it in step, both ways); kept in <account>/seen.json
//   - the same mail twice (a notice sent to both mailboxes, or twice to one): the same sender, subject and text --
//     links and addresses left out, they often differ per recipient -- share a `dup` fingerprint; the list shows one
//     of them with the others as its copies
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const pad = (n) => String(n).padStart(2, '0');
const monthOf = (t) => { const d = new Date(t); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}`; };
const norm = (s) => String(s || '').replace(/\b(?:https?:\/\/|www\.)\S+/gi, '').replace(/[\w.+-]+@[\w.-]+\.\w+/g, '').replace(/\s+/g, '').slice(0, 20000);
const dupOf = (r) => crypto.createHash('sha1').update([String(r.from && r.from.address || '').toLowerCase(), norm(r.subject), norm(r.text)].join('\n')).digest('hex').slice(0, 16);

function createMailStore({ dataDir }) {
  const root = path.join(dataDir, 'mail');
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  const index = new Map();                            // key -> the message without text
  const byMid = new Map();                            // "<acc>|<Message-ID>" -> key (the same message seen twice)
  const seenOf = new Map();                           // acc -> { key: true | false } (as last known from the mailbox)
  const head = (r) => { const { text, ...rest } = r; return { ...rest, snippet: String(text || '').replace(/\s+/g, ' ').trim().slice(0, 160) }; };
  const seenFile = (acc) => path.join(root, acc, 'seen.json');

  for (const acc of fs.readdirSync(root)) {
    let files = []; try { files = fs.readdirSync(path.join(root, acc)).filter((f) => /^\d{4}-\d{2}\.jsonl$/.test(f)); } catch {}
    let seen = {}; try { seen = JSON.parse(fs.readFileSync(seenFile(acc), 'utf8')); } catch {}
    seenOf.set(acc, seen);
    for (const f of files) {
      for (const line of fs.readFileSync(path.join(root, acc, f), 'utf8').split('\n')) {
        if (!line) continue;
        try {
          const r = JSON.parse(line);
          const h = head(r);
          if (!h.dup) h.dup = dupOf(r);                // (kept before fingerprints existed)
          if (r.key in seen) h.seen = seen[r.key];
          index.set(r.key, h); if (r.mid) byMid.set(acc + '|' + r.mid, r.key);
        } catch {}
      }
    }
  }

  const has = (key) => index.has(key);
  // r: parse.js's record + { key, acc, uid }; false when it is already there
  function add(r) {
    if (index.has(r.key) || (r.mid && byMid.has(r.acc + '|' + r.mid))) return false;
    const dir = path.join(root, r.acc);
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const rec = { ...r, dup: dupOf(r) };
    fs.appendFileSync(path.join(dir, monthOf(r.date) + '.jsonl'), JSON.stringify(rec) + '\n', { mode: 0o600 });
    index.set(r.key, head(rec));
    if (r.mid) byMid.set(r.acc + '|' + r.mid, r.key);
    return true;
  }
  // the whole message (with its text; read / unread as now)
  function get(key) {
    const h = index.get(key);
    if (!h) return null;
    const want = '{"key":' + JSON.stringify(key) + ',';
    let lines = []; try { lines = fs.readFileSync(path.join(root, h.acc, monthOf(h.date) + '.jsonl'), 'utf8').split('\n'); } catch {}
    const line = lines.find((l) => l.startsWith(want));
    let r = { ...h, text: '' }; try { if (line) r = JSON.parse(line); } catch {}
    return { ...r, seen: h.seen, dup: h.dup };
  }

  // read / unread: { key: bool } for one account (from its mailbox); returns the keys that changed
  const saveT = new Map();
  function setSeen(acc, map) {
    const seen = seenOf.get(acc) || {}; seenOf.set(acc, seen);
    const changed = [];
    for (const [key, v] of Object.entries(map)) {
      const h = index.get(key);
      if (!h || h.acc !== acc || !!h.seen === !!v) continue;
      h.seen = !!v; seen[key] = !!v; changed.push(key);
    }
    if (changed.length) {                              // (written a moment later: a refresh changes many at once)
      clearTimeout(saveT.get(acc));
      saveT.set(acc, setTimeout(() => { try { fs.writeFileSync(seenFile(acc), JSON.stringify(seen), { mode: 0o600 }); } catch {} }, 500));
    }
    return changed;
  }
  // the UIDs kept of one mailbox (with its current UIDVALIDITY): { uid: key }
  function uidsOf(acc, uv) {
    const out = {}, pre = `${acc}:${uv}:`;
    for (const k of index.keys()) if (k.startsWith(pre)) out[k.slice(pre.length)] = k;
    return out;
  }

  // newest first, the same mail once: { ...the newest copy, copies: [{ key, acc, seen }], seen: every copy read }.
  // { acc, before (date ms), limit, filter(head) }
  function list({ acc = '', before = Infinity, limit = 50, filter = null } = {}) {
    const groups = new Map();
    for (const h of index.values()) {
      if ((acc && h.acc !== acc) || (filter && !filter(h))) continue;
      const g = groups.get(h.dup);
      if (!g) groups.set(h.dup, [h]); else g.push(h);
    }
    const out = [];
    for (const g of groups.values()) {
      g.sort((a, b) => b.date - a.date);
      out.push({ ...g[0], copies: g.map((x) => ({ key: x.key, acc: x.acc, seen: !!x.seen })), seen: g.every((x) => x.seen) });
    }
    return out.filter((m) => m.date < before).sort((a, b) => b.date - a.date).slice(0, limit);
  }
  // the copies of a message (itself included)
  const copiesOf = (key) => { const h = index.get(key); return h ? [...index.values()].filter((x) => x.dup === h.dup) : []; };
  // [from, to): the daily digest's messages
  const between = (from, to) => [...index.values()].filter((h) => h.date >= from && h.date < to).sort((a, b) => a.date - b.date);
  const count = (acc) => { let n = 0; for (const h of index.values()) if (h.acc === acc) n++; return n; };
  const unread = (acc) => { let n = 0; for (const h of index.values()) if ((!acc || h.acc === acc) && !h.seen) n++; return n; };
  function removeAccount(acc) {
    for (const [k, h] of index) if (h.acc === acc) { index.delete(k); if (h.mid) byMid.delete(acc + '|' + h.mid); }
    seenOf.delete(acc);
    try { fs.rmSync(path.join(root, acc), { recursive: true, force: true }); } catch {}
  }

  return { has, add, get, list, copiesOf, between, count, unread, setSeen, uidsOf, removeAccount };
}

module.exports = { createMailStore, dupOf };
