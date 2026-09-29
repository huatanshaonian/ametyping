// Paths on the remote computer (Windows "D:\a\b" or POSIX "/a/b"), handled in the browser.
export const isWin = (p) => /^[A-Za-z]:[\\/]/.test(p) || p.includes('\\');
const sepOf = (p) => (isWin(p) ? '\\' : '/');

export function dirname(p) {
  const s = sepOf(p), i = p.replace(/[\\/]+$/, '').lastIndexOf(s);
  if (i < 0) return p;
  const d = p.slice(0, i);
  return /^[A-Za-z]:$/.test(d) ? d + '\\' : d || '/';
}
export const basename = (p) => p.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || p;

// resolve a relative reference (as written in a Markdown file: "./img/a.png", "../x.md") against a folder
export function resolve(dir, rel) {
  const s = sepOf(dir);
  const root = isWin(dir) ? dir.slice(0, 3) : '/';
  const parts = dir.slice(root.length).split(/[\\/]/).filter(Boolean);
  for (const seg of rel.replace(/\\/g, '/').split('/')) {
    if (!seg || seg === '.') continue;
    if (seg === '..') parts.pop(); else parts.push(seg);
  }
  return root + parts.join(s);
}
// a folder plus one entry name from its listing
export const join = (dir, name) => (/[\\/]$/.test(dir) ? dir : dir + sepOf(dir)) + name;
