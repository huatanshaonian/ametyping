// Things made in sessions outside a tracked repository -- scripts, plots, notes -- so they can be found again.
// The daily summary asks each machine's agent to check the files its sessions wrote (agent/artifacts.js); what is
// not committed to a repository with a remote is listed here, and files up to maxBytes are copied to the NAS.
//   <dir>/index.json    [{ machine, path, sessions: [id], first, last (report dates), size, mtime, exists, sha, backed,
//                          repo: { root, remote, tracked } | null, note }]
//   <dir>/files/<sha>   the copies, named by their sha256
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const TIMEOUT_MS = 120e3;

function createArtifacts({ dir, machines, log = () => {} }) {
  const filesDir = path.join(dir, 'files');
  fs.mkdirSync(filesDir, { recursive: true, mode: 0o700 });
  const indexFile = path.join(dir, 'index.json');
  let index = []; try { index = JSON.parse(fs.readFileSync(indexFile, 'utf8')); } catch {}
  const pending = new Map();                          // rid -> { machine, resolve, timer, results, want: Map sha -> [base64] }

  const saveIndex = () => { fs.writeFileSync(indexFile + '.tmp', JSON.stringify(index), { mode: 0o600 }); fs.renameSync(indexFile + '.tmp', indexFile); };
  const has = (sha) => /^[0-9a-f]{64}$/.test(sha) && fs.existsSync(path.join(filesDir, sha));

  // ask a machine about files its sessions wrote: [{ id, path }] -> [{ id, path, ok, exists, size, mtime, repo, sha, backed }]
  // (null when the machine is offline)
  function check(machine, items, { maxBytes = 5e6 } = {}) {
    const m = machines.get(machine);
    if (!m || !m.online || !m.sockets || !m.sockets.size || !items.length) return Promise.resolve(null);
    const rid = crypto.randomBytes(12).toString('hex');
    return new Promise((resolve) => {
      const p = { machine, resolve, results: null, want: new Map() };
      p.timer = setTimeout(() => finish(rid), TIMEOUT_MS);
      pending.set(rid, p);
      try { [...m.sockets].pop().send(JSON.stringify({ t: 'art-check', rid, items, backup: { maxBytes } })); }
      catch { clearTimeout(p.timer); pending.delete(rid); resolve(null); }
    });
  }
  function finish(rid) {
    const p = pending.get(rid); if (!p) return;
    pending.delete(rid); clearTimeout(p.timer);
    // a copy counts only once it is on disk (a timeout leaves the rest un-backed)
    p.resolve((p.results || []).map((r) => ({ ...r, backed: !!(r.sha && has(r.sha)) })));
  }

  const str = (v, n) => (typeof v === 'string' ? v.slice(0, n) : '');
  function fromAgent(m, d) {
    const p = pending.get(d.rid);
    if (!p || p.machine !== m.name) return;
    if (d.t === 'art-res') {
      p.results = (Array.isArray(d.items) ? d.items : []).slice(0, 300).map((r) => ({
        id: str(r.id, 80), path: str(r.path, 1000), ok: r.ok === true, why: str(r.why, 60), exists: r.exists === true,
        size: +r.size || 0, mtime: +r.mtime || 0, sha: /^[0-9a-f]{64}$/.test(r.sha) ? r.sha : '',
        repo: r.repo && typeof r.repo === 'object' ? { root: str(r.repo.root, 1000), remote: str(r.repo.remote, 300), tracked: r.repo.tracked === true ? true : r.repo.tracked === false ? false : null, ignored: r.repo.ignored === true } : null,
      }));
      for (const r of p.results) if (r.sha && d.items.find((x) => x.sha === r.sha && x.backed) && !has(r.sha)) p.want.set(r.sha, []);
      if (!p.want.size) finish(d.rid);
    } else if (d.t === 'art-chunk' && p.want.has(d.sha) && typeof d.data === 'string') {
      const parts = p.want.get(d.sha);
      parts.push(d.data);
      if (parts.reduce((n, s) => n + s.length, 0) > 30e6) { p.want.delete(d.sha); }      // more than promised: drop it
      else if (d.last) {
        const buf = Buffer.concat(parts.map((s) => Buffer.from(s, 'base64')));
        p.want.delete(d.sha);
        if (crypto.createHash('sha256').update(buf).digest('hex') === d.sha) fs.writeFileSync(path.join(filesDir, d.sha), buf, { mode: 0o600 });
        else log(`产出物副本校验失败：${m.name} ${d.sha.slice(0, 12)}`);
      }
      if (!p.want.size && p.results) finish(d.rid);
    }
  }

  // a report's artifacts go into the index (one entry per machine + path; the latest facts win)
  function record(date, items) {
    for (const a of items) {
      let e = index.find((x) => x.machine === a.machine && x.path === a.path);
      if (!e) { e = { machine: a.machine, path: a.path, sessions: [], first: date }; index.push(e); }
      for (const id of a.sessionIds || []) if (!e.sessions.includes(id)) e.sessions.push(id);
      if (!e.first || date < e.first) e.first = date;
      if (!e.last || date > e.last) e.last = date;
      if (!a.unchecked) Object.assign(e, { size: a.size, mtime: a.mtime, exists: a.exists, repo: a.repo || null });
      if (a.sha && a.backed) Object.assign(e, { sha: a.sha, backed: true });
      if (a.note) e.note = a.note;
    }
    saveIndex();
  }

  const list = () => index;
  const fileOf = (sha) => (has(sha) ? path.join(filesDir, sha) : null);
  return { check, fromAgent, record, list, fileOf };
}

module.exports = { createArtifacts };
