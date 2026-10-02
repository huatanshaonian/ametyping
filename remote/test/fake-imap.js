// A small IMAP server for the mail tests (TLS, self-signed): LOGIN, EXAMINE / SELECT INBOX, UID SEARCH (SINCE, UID
// range, ALL), UID FETCH (UID FLAGS INTERNALDATE RFC822.SIZE BODY[] / BODY.PEEK[]<partial>), IDLE / DONE, NOOP,
// LOGOUT -- enough for imapflow. Every command is kept (tests check nothing marks mail read: no STORE, no BODY[]
// without PEEK, EXAMINE not SELECT). add(raw) delivers a message (an IDLE-ing client is told at once).
'use strict';
const tls = require('tls');
const mime = require('./fake-mime');

const SEEN = String.raw`\Seen`;
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const idate = (t) => { const d = new Date(t); const p = (n) => String(n).padStart(2, '0'); return `${p(d.getUTCDate())}-${MON[d.getUTCMonth()]}-${d.getUTCFullYear()} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())} +0000`; };

// structure: answer BODYSTRUCTURE (false: a server that gives none -- attachments are then taken out of the whole message)
function createFakeImap({ key, cert, users, uidValidity = 777, structure = true }) {
  const box = { msgs: [], nextUid: 1, uidValidity, sent: [], nextSent: 1, sentFolder: 'Sent' };     // sent: what APPEND put in the sent folder
  const commands = [];
  const clients = new Set();
  let logins = 0, refused = 0;

  function add(raw, { date = Date.now(), seen = false } = {}) {
    const m = { uid: box.nextUid++, raw: Buffer.from(raw), date, flags: seen ? ['\\Seen'] : [] };
    box.msgs.push(m);
    for (const c of clients) if (c.idle) { c.known = box.msgs.length; c.write(`* ${box.msgs.length} EXISTS\r\n`); }
    return m.uid;
  }

  const server = tls.createServer({ key, cert }, (sock) => {
    const c = { sock, idle: null, write: (s) => { try { sock.write(s); } catch {} } };
    clients.add(c);
    sock.on('close', () => clients.delete(c));
    sock.on('error', () => {});
    c.write('* OK [CAPABILITY IMAP4rev1 IDLE UIDPLUS] fake imap ready\r\n');
    let buf = '';
    sock.on('data', (d) => {
      buf += d.toString('latin1');
      for (;;) {
        if (c.lit) {                                         // APPEND's message: so many bytes, then the line's end
          if (buf.length < c.lit.need + 2) return;
          const raw = Buffer.from(buf.slice(0, c.lit.need), 'latin1'); buf = buf.slice(c.lit.need).replace(/^\r\n/, '');
          const { tag, box: name, flags } = c.lit; c.lit = null;
          const m = { uid: box.nextSent++, raw, flags, box: name };
          box.sent.push(m);
          c.write(`${tag} OK [APPENDUID ${box.uidValidity} ${m.uid}] APPEND completed\r\n`);
          continue;
        }
        const i = buf.indexOf('\r\n');
        if (i < 0) return;
        const line = buf.slice(0, i); buf = buf.slice(i + 2);
        const ap = /^(\S+) APPEND ("(?:[^"\\]|\\.)*"|\S+)\s+(?:\(([^)]*)\)\s+)?(?:"[^"]*"\s+)?\{(\d+)\}$/i.exec(line);
        if (ap && c.user) { commands.push(line); c.lit = { tag: ap[1], box: ap[2].replace(/^"|"$/g, ''), flags: (ap[3] || '').split(/\s+/).filter(Boolean), need: +ap[4] }; c.write('+ Ready for literal data\r\n'); continue; }
        handle(c, line);
      }
    });
  });

  // \Seen on / off (from a client, or `by` null: read on the phone); IDLE-ing connections are told, by number only
  // (no UID), as many servers do
  function setFlag(uid, seen, by = null) {
    const m = box.msgs.find((x) => x.uid === uid);
    if (!m || m.flags.includes(SEEN) === seen) return;
    m.flags = seen ? [...m.flags, SEEN] : m.flags.filter((f) => f !== SEEN);
    // (a connection not IDLE-ing hears of it when it next starts to, as real servers do)
    for (const c of clients) if (c !== by) { if (c.idle) c.write(`* ${seqOf(uid)} FETCH (FLAGS (${m.flags.join(' ')}))\r\n`); else (c.flagged = c.flagged || new Set()).add(uid); }
  }
  function seqOf(uid) { return box.msgs.findIndex((m) => m.uid === uid) + 1; }
  function uidSet(spec) {
    const out = new Set(), max = box.msgs.length ? box.msgs[box.msgs.length - 1].uid : 0;
    for (const part of spec.split(',')) {
      const [a, b] = part.split(':');
      const lo = a === '*' ? max : +a, hi = b === undefined ? lo : b === '*' ? max : +b;
      for (const m of box.msgs) if (m.uid >= Math.min(lo, hi) && m.uid <= Math.max(lo, hi)) out.add(m.uid);
    }
    return [...out].sort((x, y) => x - y);
  }

  function handle(c, line) {
    if (c.idle) { if (/^DONE$/i.test(line.trim())) { c.write(`${c.idle} OK IDLE terminated\r\n`); c.idle = null; } return; }
    commands.push(line);
    const m = /^(\S+)\s+(UID\s+)?(\S+)\s*(.*)$/i.exec(line);
    if (!m) return;
    const [, tag, uidPrefix, cmdRaw, args] = m, cmd = cmdRaw.toUpperCase();
    const ok = (t = 'done') => c.write(`${tag} OK ${t}\r\n`);
    if (cmd === 'CAPABILITY') { c.write('* CAPABILITY IMAP4rev1 IDLE UIDPLUS\r\n'); return ok(); }
    if (cmd === 'NOOP') return ok();
    if (cmd === 'LOGOUT') { c.write('* BYE bye\r\n'); ok(); return c.sock.end(); }
    if (cmd === 'LOGIN') {
      const q = [...args.matchAll(/"((?:[^"\\]|\\.)*)"|(\S+)/g)].map((x) => (x[1] !== undefined ? x[1].replace(/\\(.)/g, '$1') : x[2]));
      if (users[q[0]] && users[q[0]] === q[1]) { logins++; c.user = q[0]; return ok('[CAPABILITY IMAP4rev1 IDLE UIDPLUS] LOGIN completed'); }
      refused++;
      return c.write(`${tag} NO [AUTHENTICATIONFAILED] Invalid credentials\r\n`);
    }
    if (!c.user) return c.write(`${tag} BAD not logged in\r\n`);
    if (cmd === 'EXAMINE' || cmd === 'SELECT') {
      const last = box.msgs.length ? box.msgs[box.msgs.length - 1].uid : 0;
      c.known = box.msgs.length;
      c.readOnly = cmd === 'EXAMINE';
      c.write(`* FLAGS (\\Answered \\Flagged \\Deleted \\Seen \\Draft)\r\n* ${box.msgs.length} EXISTS\r\n* 0 RECENT\r\n` +
        `* OK [UIDVALIDITY ${box.uidValidity}] UIDs valid\r\n* OK [UIDNEXT ${Math.max(box.nextUid, last + 1)}] next\r\n* OK [PERMANENTFLAGS (${c.readOnly ? '' : '\\Answered \\Flagged \\Deleted \\Seen \\Draft \\*'})] flags\r\n`);
      return ok(cmd === 'EXAMINE' ? '[READ-ONLY] EXAMINE completed' : '[READ-WRITE] SELECT completed');
    }
    // (what arrived since it last heard is told as IDLE starts, as real servers do)
    if (cmd === 'IDLE') {
      c.idle = tag; c.write('+ idling\r\n');
      if (box.msgs.length > (c.known || 0)) { c.known = box.msgs.length; c.write(`* ${box.msgs.length} EXISTS\r\n`); }
      for (const uid of c.flagged || []) { const m = box.msgs.find((x) => x.uid === uid); if (m) c.write(`* ${seqOf(uid)} FETCH (FLAGS (${m.flags.join(' ')}))\r\n`); }
      c.flagged = null;
      return;
    }
    if (cmd === 'LIST' || cmd === 'LSUB') {                       // (imapflow asks for the delimiter, then INBOX)
      if (/""\s*$/.test(args)) c.write(`* ${cmd} (\\Noselect) "/" ""\r\n`);
      else if (/[*%]/.test(args)) c.write(`* ${cmd} (\\HasNoChildren) "/" INBOX\r\n` + (box.sentFolder ? `* ${cmd} (\\HasNoChildren \\Sent) "/" "${box.sentFolder}"\r\n` : ''));
      else if (/INBOX/i.test(args)) c.write(`* ${cmd} (\\HasNoChildren) "/" INBOX\r\n`);
      return ok(`${cmd} completed`);
    }
    if (cmd === 'SEARCH' && uidPrefix) {
      let hits = box.msgs.map((x) => x.uid);
      const since = /SINCE\s+"?(\d{1,2})-(\w{3})-(\d{4})"?/i.exec(args);
      if (since) { const t = Date.UTC(+since[3], MON.indexOf(since[2]), +since[1]); hits = box.msgs.filter((x) => x.date >= t).map((x) => x.uid); }
      const ur = /UID\s+([\d:*,]+)/i.exec(args);
      if (ur) { const set = new Set(uidSet(ur[1])); hits = hits.filter((u) => set.has(u)); }
      c.write(`* SEARCH${hits.length ? ' ' + hits.join(' ') : ''}\r\n`);
      return ok('SEARCH completed');
    }
    if (cmd === 'FETCH' && uidPrefix) {
      const sm = /^([\d:*,]+)\s+(.*)$/.exec(args);
      const want = sm[2];
      for (const uid of uidSet(sm[1])) {
        const msg = box.msgs.find((x) => x.uid === uid);
        // (BODY[...] without PEEK would mark it read, as a real server does)
        if (/BODY\[/i.test(want) && !msg.flags.includes(SEEN)) msg.flags.push(SEEN);
        let head = `* ${seqOf(uid)} FETCH (UID ${uid} FLAGS (${msg.flags.join(' ')})`;
        if (/INTERNALDATE/i.test(want)) head += ` INTERNALDATE "${idate(msg.date)}"`;
        if (/RFC822\.SIZE/i.test(want)) head += ` RFC822.SIZE ${msg.raw.length}`;
        if (/BODYSTRUCTURE/i.test(want) && structure) head += ` BODYSTRUCTURE ${mime.structure(mime.parse(msg.raw))}`;
        // every BODY[section]<partial> asked for, as literals
        const bodies = [...want.matchAll(/BODY(?:\.PEEK)?\[([^\]]*)\](?:<(\d+)\.(\d+)>)?/gi)];
        if (!bodies.length) { c.write(head + ')\r\n'); continue; }
        c.write(head);
        for (const b of bodies) {
          let data = mime.section(mime.parse(msg.raw), b[1].toUpperCase().replace(/^(\d+(?:\.\d+)*)\.MIME$/, '$1.MIME'));
          if (b[2] !== undefined) data = data.subarray(+b[2], +b[2] + +b[3]);
          c.write(` BODY[${b[1]}]${b[2] !== undefined ? `<${b[2]}>` : ''} {${data.length}}\r\n`);
          c.sock.write(data);
        }
        c.write(')\r\n');
      }
      return ok('FETCH completed');
    }
    // read / unread: only in a mailbox opened read-write; the other connections hear of it
    if (cmd === 'STORE' && uidPrefix) {
      const sm = /^([\d:*,]+)\s+([+-])FLAGS(?:\.SILENT)?\s+\(([^)]*)\)/i.exec(args);
      if (!sm) return c.write(`${tag} BAD bad STORE\r\n`);
      if (c.readOnly) return c.write(`${tag} NO mailbox is read-only\r\n`);
      for (const f of sm[3].split(/\s+/).filter(Boolean)) {
        for (const uid of uidSet(sm[1])) {
          if (f.toLowerCase() === SEEN.toLowerCase()) { setFlag(uid, sm[2] === '+', c); continue; }
          const m = box.msgs.find((x) => x.uid === uid);           // (other flags: \Answered, \Flagged, ...)
          if (m) m.flags = sm[2] === '+' ? [...new Set([...m.flags, f])] : m.flags.filter((x) => x !== f);
        }
      }
      return ok('STORE completed');
    }
    c.write(`${tag} BAD unknown command ${cmd}\r\n`);
  }

  return {
    box, commands, add, server, setFlag, setStructure: (v) => { structure = !!v; },
    listen: (port) => new Promise((r) => server.listen(port, '127.0.0.1', r)),
    stats: () => ({ logins, refused, clients: clients.size }),
    // drop every connection (the server "restarts")
    kick: () => { for (const c of clients) c.sock.destroy(); },
    close: () => new Promise((r) => { for (const c of clients) c.sock.destroy(); server.close(() => r()); }),
  };
}

module.exports = { createFakeImap };
