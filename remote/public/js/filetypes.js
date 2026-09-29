// What a file is (by extension): how to open it and which icon it gets.
const IMAGE = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'ico', 'svg', 'avif']);
const MD = new Set(['md', 'markdown', 'mdown', 'mkd']);
const TEXT = new Set(['txt', 'log', 'json', 'jsonl', 'js', 'mjs', 'cjs', 'ts', 'tsx', 'jsx', 'py', 'ipynb', 'c', 'h', 'cpp', 'hpp', 'cc', 'cs', 'java',
  'kt', 'go', 'rs', 'rb', 'php', 'lua', 'r', 'm', 'jl', 'f', 'f90', 'sh', 'bash', 'zsh', 'bat', 'cmd', 'ps1', 'psm1', 'yaml', 'yml', 'toml', 'ini',
  'cfg', 'conf', 'env.example', 'csv', 'tsv', 'xml', 'html', 'htm', 'css', 'scss', 'less', 'sql', 'tex', 'bib', 'rst', 'org', 'gitignore',
  'gitattributes', 'dockerfile', 'makefile', 'cmake', 'gradle', 'properties', 'service', 'vue', 'svelte', 'diff', 'patch', 'srt', 'vtt']);
const MIME = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', bmp: 'image/bmp',
  ico: 'image/x-icon', svg: 'image/svg+xml', avif: 'image/avif' };

const ext = (name) => { const n = name.toLowerCase(); const i = n.lastIndexOf('.'); return i > 0 ? n.slice(i + 1) : n; };
export function kindOf(name) {
  const e = ext(name);
  if (IMAGE.has(e)) return 'image';
  if (MD.has(e)) return 'md';
  if (TEXT.has(e)) return 'text';
  return 'other';
}
export const mimeOf = (name) => MIME[ext(name)] || '';
export function iconOf(entry) {
  if (entry.dir) return 'directory_closed';
  return { image: 'kodak_imaging_file', md: 'document', text: 'notepad_file', other: 'notepad_file' }[kindOf(entry.name)];
}
export function size(n) {
  if (n < 1024) return n + ' B';
  if (n < 1024 * 1024) return (n / 1024).toFixed(n < 10240 ? 1 : 0) + ' KB';
  return (n / 1024 / 1024).toFixed(1) + ' MB';
}
