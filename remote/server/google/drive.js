// Google Drive for the connected account: a note (server/notes.js) copied as a text file into the folder
// 「Windose 记事本」 (created on first use). With the drive.file scope only files this app made are visible to it.
// A note copied before is updated in place (same file), so Drive holds one copy per note.
'use strict';
const crypto = require('crypto');

const FILES = 'https://www.googleapis.com/drive/v3/files';
const UPLOAD = 'https://www.googleapis.com/upload/drive/v3/files';
const FOLDER = 'Windose 记事本';

function createDrive({ account, log = () => {} }) {
  async function folder() {
    const known = account.get('driveFolder');
    if (known) {
      try { const f = await account.api(`${FILES}/${encodeURIComponent(known)}?fields=id,trashed`); if (f && !f.trashed) return known; } catch {}
    }
    const f = await account.api(FILES + '?fields=id', { method: 'POST', json: { name: FOLDER, mimeType: 'application/vnd.google-apps.folder' } });
    account.remember('driveFolder', f.id);
    return f.id;
  }

  // note: { id, title, text, drive? } -> { fileId, name }
  async function saveNote(note) {
    const name = (note.title || '无标题').replace(/[\\/:*?"<>|]/g, '_').slice(0, 80) + '.txt';
    if (note.drive && note.drive.fileId) {
      try {
        await account.api(`${UPLOAD}/${encodeURIComponent(note.drive.fileId)}?uploadType=media`, { method: 'PATCH', headers: { 'Content-Type': 'text/plain; charset=utf-8' }, body: Buffer.from(note.text, 'utf8') });
        await account.api(`${FILES}/${encodeURIComponent(note.drive.fileId)}`, { method: 'PATCH', json: { name } });
        return { fileId: note.drive.fileId, name };
      } catch (e) { if (!/404/.test(e.message)) throw e; }                    // deleted on Drive: upload anew
    }
    const parent = await folder();
    const b = 'ame' + crypto.randomBytes(8).toString('hex');
    const body = Buffer.concat([
      Buffer.from(`--${b}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify({ name, parents: [parent], mimeType: 'text/plain' })}\r\n--${b}\r\nContent-Type: text/plain; charset=UTF-8\r\n\r\n`),
      Buffer.from(note.text, 'utf8'), Buffer.from(`\r\n--${b}--`)]);
    const f = await account.api(`${UPLOAD}?uploadType=multipart&fields=id,name`, { method: 'POST', headers: { 'Content-Type': 'multipart/related; boundary=' + b }, body });
    log(`Google 云端硬盘：转存笔记「${note.title}」`);
    return { fileId: f.id, name: f.name };
  }
  return { saveNote };
}

module.exports = { createDrive };
