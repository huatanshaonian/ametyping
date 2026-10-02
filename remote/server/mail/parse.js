// One message from the IMAP server -> what is kept of it: who, to whom, when, subject, the text (plain; an HTML-only
// message is turned into text), the attachments' names and sizes (not their content), whether it was sent to me
// directly / as a copy / to a list, and what replying needs (Message-ID, References).
// The source may be cut short for a very large message (imap.js fetches the first few MB): the text is at the start,
// the attachments are then listed from the message's structure instead.
'use strict';
const { simpleParser } = require('mailparser');

const TEXT_MAX = 100000;                             // characters of text kept per message

const addr = (a) => ({ name: String(a.name || '').slice(0, 80), address: String(a.address || '').toLowerCase().slice(0, 200) });
const addrs = (v) => (v ? (Array.isArray(v) ? v : [v]).flatMap((x) => x.value || []).filter((a) => a.address).map(addr).slice(0, 50) : []);

// a rough HTML -> text, for messages without a plain-text part (mailparser's own conversion is the first choice);
// a link keeps its address: 「text (https://…)」
function htmlText(html) {
  return String(html || '').replace(/<(script|style|head)[\s\S]*?<\/\1>/gi, '')
    .replace(/<a\b[^>]*?href\s*=\s*["']?(https?:[^"'\s>]+)["']?[^>]*>([\s\S]*?)<\/a>/gi, (m, href, t) => { const x = t.replace(/<[^>]+>/g, '').trim(); return x && x !== href ? `${x} (${href})` : href; })
    .replace(/<br\s*\/?>|<\/(p|div|tr|li|h\d)>/gi, '\n')
    .replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&amp;/g, '&')
    .replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}

// attachments from the BODYSTRUCTURE (imapflow's tree): parts with a file name, or marked as attachments
function fromStructure(node, out = []) {
  if (!node) return out;
  const name = (node.dispositionParameters && node.dispositionParameters.filename) || (node.parameters && node.parameters.name) || '';
  if (!node.childNodes && (node.disposition === 'attachment' || name)) out.push({ name: String(name || '未命名').slice(0, 200), size: node.size || 0, type: node.type || '' });
  for (const c of node.childNodes || []) fromStructure(c, out);
  return out;
}

// me: this account's address. msg: { uid, flags (Set), internalDate, size, bodyStructure, source (Buffer), cut (bool) }
async function parse(msg, me) {
  const m = await simpleParser(msg.source, { skipImageLinks: true, skipTextToHtml: true });
  const h = m.headers;
  const to = addrs(m.to), cc = addrs(m.cc);
  const mine = (l) => l.some((a) => a.address === me);
  // a list or bulk mail (mailparser gathers the List-* headers under 'list')
  const bulk = h.has('list') || h.has('list-id') || /bulk|list|junk/i.test(String(h.get('precedence') || '')) || /auto-/i.test(String(h.get('auto-submitted') || ''));
  let text = m.text || htmlText(m.html);
  if (text.length > TEXT_MAX) text = text.slice(0, TEXT_MAX) + '\n……（太长，后面省略）';
  if (msg.cut) text += '\n……（邮件很大，只读了开头）';
  const att = msg.cut || !m.attachments ? fromStructure(msg.bodyStructure)
    : m.attachments.filter((a) => !a.related).map((a) => ({ name: String(a.filename || '未命名').slice(0, 200), size: a.size || 0, type: a.contentType || '' }));
  const refs = h.get('references');
  return {
    mid: String(m.messageId || '').slice(0, 300),
    date: (m.date || msg.internalDate || new Date()).getTime(),
    from: addrs(m.from)[0] || { name: '', address: '' },
    to, cc,
    replyTo: addrs(m.replyTo)[0] || null,
    subject: String(m.subject || '').slice(0, 500),
    text,
    att: att.slice(0, 50),
    size: msg.size || 0,
    seen: !!(msg.flags && msg.flags.has && msg.flags.has('\\Seen')),
    direct: mine(to), copy: !mine(to) && mine(cc), bulk,
    inReplyTo: String(m.inReplyTo || '').slice(0, 300),
    refs: (Array.isArray(refs) ? refs : refs ? String(refs).split(/\s+/) : []).filter(Boolean).slice(-20),
  };
}

module.exports = { parse, htmlText, fromStructure };
