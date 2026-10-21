// File paths in what Claude says ("docs/figures/fdtd/plot.png", `remote/agent/agent.js:213`, D:\proj\a.py, /home/x/b.md)
// become links. A click opens the file on that session's computer (viewer.js; a text file at the line named); the
// right-click menu also offers its folder in 我的电脑 with the file picked. A relative path is taken from the session's
// folder -- or one or two folders up, where it is found first (Claude Code may have moved into a subfolder).
import { esc } from '../util.js';
import * as fsc from '../fs.js';
import * as rpath from '../rpath.js';

// Folder names: Latin letters, digits, _ . @ + - (no spaces); Chinese ones too in an absolute Windows path. Chinese
// text runs straight into a path ("图在docs/a.png里"), so a relative path starts at a Latin character and its file
// name ends at its extension.
const SEG = '[A-Za-z0-9_.@+\\-]+';
const SEGU = '[\\p{L}\\p{N}_.@+\\-]+';
const NAME = '[\\p{L}\\p{N}_@+\\-][\\p{L}\\p{N}_.@+\\-]*\\.(?=[A-Za-z0-9]*[A-Za-z])[A-Za-z0-9]{1,8}(?![A-Za-z0-9_])';
const DIRS = `(?:[A-Za-z]:[\\\\/](?:${SEGU}[\\\\/])*|/(?:${SEG}/)*|(?:\\.{1,2}[\\\\/])?(?:${SEG}[\\\\/])+)`;
const LINE = '(?::(\\d+)(?:[-–](\\d+)|:\\d+)?|#L(\\d+)(?:-L?(\\d+))?)?';
// (not inside a longer word, a URL, a ~ path or another path)
const IN_TEXT = new RegExp(`(?<![A-Za-z0-9_.@+~:/\\\\\\-])(${DIRS}${NAME})${LINE}`, 'gu');
const WHOLE = new RegExp(`^(${DIRS}${NAME})${LINE}$`, 'u');

const link = (p, from, to, inner) => `<a class="fp" href="#" data-p="${esc(p)}"${from ? ` data-l="${from}"` : ''}${to ? ` data-l2="${to}"` : ''} title="在这台电脑上打开 ${esc(p)}${from ? ' 第 ' + from + ' 行' : ''}">${inner}</a>`;

// plain text -> HTML with the paths in it as links
function textHtml(s) {
  let out = '', at = 0;
  for (const m of s.matchAll(IN_TEXT)) {
    out += esc(s.slice(at, m.index)) + link(m[1], m[2] || m[4], m[3] || m[5], esc(m[0]));
    at = m.index + m[0].length;
  }
  return out + esc(s.slice(at));
}

// one paragraph of Markdown, inline: `code` (a path alone in it is a link), **bold**, # headings, paths
export function inline(s) {
  const html = String(s).split(/`([^`\n]+)`/).map((part, i) => {
    if (!(i % 2)) return textHtml(part);
    const m = part.trim().match(WHOLE);
    return m ? link(m[1], m[2] || m[4], m[3] || m[5], `<code>${esc(part)}</code>`) : `<code>${esc(part)}</code>`;
  }).join('');
  return html.replace(/\*\*([^*\n]+)\*\*/g, '<b>$1</b>').replace(/^#{1,6}\s+(.+)$/gm, '<b>$1</b>');
}

const sameName = (a, b, win) => (win ? a.toLowerCase() === b.toLowerCase() : a === b);
const absolute = (p) => /^[A-Za-z]:[\\/]/.test(p) || p.startsWith('/');

// the old way, for a computer whose agent cannot look for itself yet (no "locate"): the path as written if absolute;
// else from the session's folder, or one or two folders up -- listing each folder from here.
// -> { ok, found: [{ path }] } or { ok: false, msg }
async function locateHere(machine, cwd, p) {
  let tries;
  if (absolute(p)) tries = [rpath.isWin(p) ? p.replace(/\//g, '\\') : p];
  else {
    if (!cwd) return { ok: false, msg: '不知道这个会话在哪个文件夹，没法找相对路径' };
    tries = [];
    for (let d = cwd, k = 0; k < 3; k++) {
      tries.push(rpath.resolve(d, p));
      const up = rpath.dirname(d);
      if (up === d) break;
      d = up;
    }
  }
  let lastMsg = '';
  for (const full of [...new Set(tries)]) {
    const r = await fsc.list(machine, rpath.dirname(full));
    if (!r.ok) { lastMsg = r.msg || ''; continue; }
    const name = rpath.basename(full), win = rpath.isWin(full);
    const e = (r.entries || []).find((x) => !x.dir && sameName(x.name, name, win));
    if (e) return { ok: true, found: [{ path: rpath.join(r.path || rpath.dirname(full), e.name) }] };
  }
  return { ok: false, msg: `找不到 ${p}${lastMsg && /权限|允许|不在|没开放/.test(lastMsg) ? `（${lastMsg}）` : `（在 ${cwd || '这台电脑'} 和上两级里都没有）`}` };
}

// where the file is: the computer's agent looks (agent/locate.js: where the session was when it said it, the full
// paths it used, its other folders, then a bounded search); an older agent: locateHere
async function where(machine, session, cwd, p, at) {
  const r = await fsc.locate(machine, p, session, at);
  if (!r.ok && r.msg === '无效请求') return locateHere(machine, cwd, p);
  return r.ok && !(r.found || []).length ? { ok: false, msg: `找不到 ${p}` } : r;
}

const HOW = { cwd: '它当时所在的文件夹', session: '会话里用过的路径', folder: '会话到过的文件夹', search: '搜到的', abs: '' };

// a link clicked or picked from its menu: open it (viewer.js), or show it in its folder (explorer.js). Found in more
// than one place (a search, a project with several copies): picked from a menu at the link.
export async function follow(a, { machine, session, cwd, files, note, folder = false }) {
  if (!files) return note(`${machine} 没开放文件浏览，打不开`, true);
  const p = a.dataset.p, line = +a.dataset.l || 0, to = +a.dataset.l2 || 0;
  const m = a.closest('[data-t]'), at = m ? +m.dataset.t || undefined : undefined;   // (when it was said)
  note(`正在找 ${p}…`);
  const r = await where(machine, session, cwd, p, at);
  if (!r.ok) return note(r.msg, true);
  note('');
  const go = async (full) => {
    const name = rpath.basename(full);
    if (folder) { const ex = await import('./explorer.js'); ex.open(machine, rpath.dirname(full), name); return; }
    const [{ openFile }, ex] = await Promise.all([import('./viewer.js'), import('./explorer.js')]);
    openFile(machine, full, { name, size: 0 }, ex.openPath, line ? { line, to: to >= line ? to : line } : undefined);
  };
  if (r.found.length === 1) return go(r.found[0].path);
  const ctx = await import('../ctxmenu.js'), b = a.getBoundingClientRect();
  ctx.show(b.left, b.bottom, [{ label: `找到 ${r.found.length} 个 ${rpath.basename(p)}，打开哪一个？`, disabled: true }, '-',
    ...r.found.map((f) => ({ label: f.path + (HOW[f.how] ? `（${HOW[f.how]}）` : ''), onClick: () => go(f.path) }))]);
}
