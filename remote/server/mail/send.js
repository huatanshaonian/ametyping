// Sending a mail from one of the mailboxes: the message is put together once (nodemailer's composer), the same bytes
// go out by SMTP (SSL; 465 / 994 -- 587 / 25 by STARTTLS) and into the mailbox's sent folder by IMAP APPEND, so the webmail and the
// phone show it as sent; a reply marks the mail it answers \Answered. Those two afterwards are reported, never undo a
// sent mail. From is always the mailbox itself.
'use strict';
const nodemailer = require('nodemailer');
const MailComposer = require('nodemailer/lib/mail-composer');
const { ImapFlow } = require('imapflow');

const SENT_NAMES = /^(sent|sent items|sent messages|sent mail|已发送|已发送邮件)$/i;

// mail: { to, cc, bcc: [{ name, address }], subject, text, inReplyTo, references: [], attachments: [{ filename, content (Buffer), contentType }] }
function compose(account, mail) {
  const C = MailComposer.default || MailComposer;
  return new Promise((resolve, reject) => new C({
    from: { name: account.name || '', address: account.address }, to: mail.to, cc: mail.cc, bcc: mail.bcc, subject: mail.subject, text: mail.text,
    inReplyTo: mail.inReplyTo || undefined, references: mail.references && mail.references.length ? mail.references : undefined,
    attachments: mail.attachments || [], headers: { 'X-Mailer': 'Windose' },
  }).compile().build((e, buf) => (e ? reject(e) : resolve(buf))));
}

const imapOptions = (account) => ({ host: account.imap.host, port: account.imap.port, secure: true, auth: { user: account.address, pass: account.pass },
  logger: false, connectionTimeout: 30e3, greetingTimeout: 30e3, clientInfo: { name: 'Windose', version: '1' } });

// -> { ok, messageId, sent: true, saved: bool, answered: bool, notes: [] }
// options: transport(account) -> nodemailer transport (tests: a stand-in); client(options) -> ImapFlow
async function sendMail({ account, mail, answer = null, transport, client: makeClient = (o) => new ImapFlow(o) }) {
  const raw = await compose(account, mail);
  const envelope = { from: account.address, to: [...mail.to, ...(mail.cc || []), ...(mail.bcc || [])].map((a) => a.address) };
  // (SSL from the start -- 中国科技网's 465 / 994; only 587 / 25 begin plain and switch with STARTTLS)
  const tr = transport ? transport(account) : nodemailer.createTransport({ host: account.smtp.host, port: account.smtp.port, secure: ![587, 25].includes(account.smtp.port),
    auth: { user: account.address, pass: account.pass }, connectionTimeout: 30e3, greetingTimeout: 30e3, socketTimeout: 60e3 });
  const info = await tr.sendMail({ envelope, raw });
  try { tr.close && tr.close(); } catch {}
  const out = { ok: true, messageId: info.messageId || (/^Message-ID:\s*(<[^>]+>)/mi.exec(raw.toString('latin1')) || [])[1] || '', saved: false, answered: false, notes: [] };

  // afterwards, on the mailbox: a copy in its sent folder; the mail answered marked so
  const cl = makeClient(imapOptions(account));
  try {
    await cl.connect();
    let sent = null;
    try {
      const boxes = await cl.list();
      sent = boxes.find((b) => b.specialUse === '\\Sent') || boxes.find((b) => SENT_NAMES.test(b.name || '') || SENT_NAMES.test(b.path || ''));
    } catch {}
    if (sent) { await cl.append(sent.path, raw, ['\\Seen']); out.saved = true; }
    else out.notes.push('邮箱里没找到「已发送」文件夹，没存副本');
    if (answer && answer.uid) {
      await cl.mailboxOpen('INBOX');
      if (String(cl.mailbox.uidValidity) === String(answer.uv)) { await cl.messageFlagsAdd(String(answer.uid), ['\\Answered'], { uid: true }); out.answered = true; }
    }
  } catch (e) { out.notes.push('已发出，但' + (out.saved ? '没能把原邮件标为已回复' : '没能存进「已发送」') + '：' + (e.responseText || e.message)); }
  finally { try { await cl.logout(); } catch { try { cl.close(); } catch {} } }
  return out;
}

module.exports = { sendMail, compose };
