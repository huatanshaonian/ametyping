// For the fake IMAP server (fake-imap.js): a raw message split into its MIME parts, and its IMAP BODYSTRUCTURE --
// enough for the test messages (one level of multipart, ASCII parameter values; RFC 2231 file names pass through).
'use strict';

function splitHead(buf) {
  const s = buf.toString('latin1'), i = s.search(/\r?\n\r?\n/);
  const head = i < 0 ? s : s.slice(0, i), sep = i < 0 ? 0 : (s.slice(i).startsWith('\r\n\r\n') ? 4 : 2);
  const headers = {};
  for (const line of head.replace(/\r?\n[ \t]+/g, ' ').split(/\r?\n/)) { const m = /^([^:]+):\s*(.*)$/.exec(line); if (m) headers[m[1].toLowerCase()] = m[2]; }
  return { headers, head: Buffer.from(head + '\r\n\r\n', 'latin1'), body: i < 0 ? Buffer.alloc(0) : buf.subarray(i + sep) };
}
function params(v) {
  const out = {};
  for (const m of String(v || '').matchAll(/;\s*([\w*-]+)\s*=\s*("([^"]*)"|[^;\s]+)/g)) out[m[1].toLowerCase()] = m[3] !== undefined ? m[3] : m[2];
  return out;
}

// { headers, head, body, type, subtype, params, parts? } -- parts numbered as IMAP does (1, 2, ...)
function parse(buf) {
  const { headers, head, body } = splitHead(buf);
  const ct = headers['content-type'] || 'text/plain; charset=us-ascii';
  const [type, subtype] = ct.split(';')[0].trim().toLowerCase().split('/');
  const node = { headers, head, body, type, subtype, params: params(ct) };
  if (type === 'multipart' && node.params.boundary) {
    const b = '--' + node.params.boundary, s = body.toString('latin1');
    node.parts = s.split(b).slice(1).filter((x) => !x.startsWith('--')).map((x) => parse(Buffer.from(x.replace(/^\r?\n/, '').replace(/\r?\n$/, ''), 'latin1')));
  }
  return node;
}

const q = (v) => (v == null ? 'NIL' : '"' + String(v).replace(/["\\]/g, '\\$&') + '"');
const plist = (o) => { const e = Object.entries(o); return e.length ? '(' + e.map(([k, v]) => `${q(k.toUpperCase())} ${q(v)}`).join(' ') + ')' : 'NIL'; };
function structure(n) {
  if (n.parts) return '(' + n.parts.map(structure).join('') + ` ${q(n.subtype.toUpperCase())} ${plist({ boundary: n.params.boundary })} NIL NIL NIL)`;
  const enc = (n.headers['content-transfer-encoding'] || '7bit').toUpperCase();
  const p = { ...n.params };
  const disp = n.headers['content-disposition'];
  const dispo = disp ? `(${q(disp.split(';')[0].trim().toUpperCase())} ${plist(params(disp))})` : 'NIL';
  const basic = `${q(n.type.toUpperCase())} ${q(n.subtype.toUpperCase())} ${plist(p)} NIL NIL ${q(enc)} ${n.body.length}`;
  return n.type === 'text' ? `(${basic} ${n.body.toString('latin1').split('\n').length} NIL ${dispo} NIL NIL)` : `(${basic} NIL ${dispo} NIL NIL)`;
}
// the bytes of BODY[section]: "", "2", "2.MIME", "HEADER", "TEXT"
function section(n, sec) {
  if (!sec) return Buffer.concat([n.head, n.body]);
  if (sec === 'HEADER') return n.head;
  if (sec === 'TEXT') return n.body;
  const [num, ...rest] = sec.split('.');
  const p = n.parts ? n.parts[+num - 1] : +num === 1 ? n : null;
  if (!p) return Buffer.alloc(0);
  if (rest[0] === 'MIME') return p.head;
  return rest.length ? section(p, rest.join('.')) : p.body;
}

module.exports = { parse, structure, section };
