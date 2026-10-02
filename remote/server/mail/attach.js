// A mail's attachment, fetched from the mailbox when it is opened (attachments are not kept on the NAS): a short
// connection of its own, the inbox opened read-only. The message's structure says where the attachment is (by name,
// else by its place in the list), and only that part is fetched (imapflow decodes it); a server that gives no
// structure: the whole message is fetched and the attachment taken out of it.
'use strict';
const { ImapFlow } = require('imapflow');
const { simpleParser } = require('mailparser');
const { Readable } = require('stream');
const { fromStructure } = require('./parse');

// account: with its password; uv: the UIDVALIDITY its kept mail belongs to. client(options): ImapFlow (tests: a stand-in)
// -> fetch(uid, i, name): { name, type, stream, close() } -- close() when the stream has been sent
async function fetchAttachment({ account, uid, i, name, client: makeClient = (o) => new ImapFlow(o) }) {
  const cl = makeClient({ host: account.imap.host, port: account.imap.port, secure: true, auth: { user: account.address, pass: account.pass },
    logger: false, connectionTimeout: 30e3, greetingTimeout: 30e3, clientInfo: { name: 'Windose', version: '1' } });
  const close = () => cl.logout().catch(() => { try { cl.close(); } catch {} });
  try {
    await cl.connect();
    await cl.mailboxOpen('INBOX', { readOnly: true });
    const m = await cl.fetchOne(String(uid), { uid: true, bodyStructure: true }, { uid: true });
    if (!m) throw new Error('邮箱里已经没有这封邮件了');
    const parts = fromStructure(m.bodyStructure).filter((p) => p.part);
    const p = parts.find((x) => x.name === name) || parts[i];
    if (p) {
      const { meta, content } = await cl.download(String(uid), p.part, { uid: true });
      return { name: p.name, type: (meta && meta.contentType) || p.type || 'application/octet-stream', stream: content, close };
    }
    // no structure to go by: the whole message, the attachment taken out of it
    const whole = await cl.fetchOne(String(uid), { uid: true, source: true }, { uid: true });
    const parsed = await simpleParser(whole.source);
    const atts = (parsed.attachments || []).filter((a) => !a.related);
    const a = atts.find((x) => x.filename === name) || atts[i];
    if (!a) throw new Error('找不到这个附件');
    close();
    return { name: a.filename || name || '附件', type: a.contentType || 'application/octet-stream', stream: Readable.from([a.content]), close: () => {} };
  } catch (e) { close(); throw e; }
}

module.exports = { fetchAttachment };
