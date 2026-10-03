// The 文献 windows' calls to the server (/api/lit, server/literature/index.js) and the server's 'lit' events
// (what changed: feed, library, kb, proposals, zotero, card:<key>, read:<key>).
import * as net from '../net.js';

export async function get(url) {
  try { const r = await fetch(url); if (r.status === 401) { location.href = '/login'; return null; } return r.ok ? await r.json() : null; } catch { return null; }
}
export const post = (url, body) => net.post(url, body);
// subscribe to the server's changes; fn(what) -- returns the unsubscribe function
export const onLit = (fn) => net.on('lit', (d) => fn(String((d && d.what) || '')));

export const STATUS = { quick: '速读卡', deep: '深读卡', reviewed: '已核对', none: '' };
export const authors = (a) => (a || []).slice(0, 3).map((x) => String(x).split(',')[0]).join('、') + ((a || []).length > 3 ? ' 等' : '');
// one key per window id: the reader of a paper
export const readerId = (key) => 'lit-read:' + key;
