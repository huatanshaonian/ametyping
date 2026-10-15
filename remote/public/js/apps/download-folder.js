// A remote folder saved to this device as <name>.zip (我的电脑's 下载 with a folder picked). First every folder in it
// is listed through the agent, as the explorer lists one, to count what there is; then the files are read, a few at a
// time, as download.js reads one, and put into a zip made here (zip.js) with the folders as they were, empty ones too.
// What cannot come along -- a file over the agent's 100 MB, one it refuses or cannot read, a folder of more than 5 000
// entries (only those listed), a link back into a folder already taken -- is left out, and named in a
// 未打包的文件.txt beside the folder in the zip. Altogether at most MAX_FILES files and MAX_BYTES: everything is held
// in the browser until the zip is handed over.
// -> { promise (settles when it is over, whichever way), cancel }
import * as fsc from '../fs.js';
import * as rpath from '../rpath.js';
import { size as fmtSize } from '../filetypes.js';
import { createZip } from './zip.js';
import { save } from './download.js';

const MAX_FILES = 10000;
const MAX_BYTES = 1024 * 1024 * 1024;
const FILE_MAX = 100 * 1024 * 1024;       // (what the agent will read: agent/files.js)
const AT_ONCE = 3;                        // files read at the same time
const SKIPPED = '未打包的文件.txt';

export function downloadFolder(machine, path, entry, say) {
  const name = entry.name;
  let stopped = false;
  const running = new Set();
  const cancel = () => { stopped = true; for (const j of running) j.cancel(); };
  const promise = run().catch((e) => say(`${name}：${e.message || '打包失败'}`));
  return { promise, cancel };

  async function run() {
    say(`清点 ${name}…`);
    const all = await walk(machine, path, entry, () => stopped, say);
    if (stopped) { say(`已取消下载 ${name}`); return; }
    const { files, dirs, skipped, bytes } = all;
    if (all.over) {
      say(`${name} 太大了（已超过 ${files.length > MAX_FILES ? MAX_FILES + ' 个文件' : fmtSize(MAX_BYTES)}），网页里打包下载不了；可以分几个小文件夹下载`);
      return;
    }
    const zip = createZip();
    for (const d of dirs) zip.dir(d.rel, d.mtime);
    const partial = new Map();
    let next = 0, done = 0, got = 0, put = 0;
    const show = () => { let g = got; for (const v of partial.values()) g += v; say(`下载 ${name}：${done} / ${files.length} 个文件，${fmtSize(g)} / ${fmtSize(bytes)}`); };
    show();
    async function worker() {
      while (!stopped && next < files.length) {
        const f = files[next++], key = {};
        const job = fsc.read(machine, f.path, (g) => { partial.set(key, g); show(); });
        running.add(job);
        const r = await job.promise;
        running.delete(job); partial.delete(key);
        if (stopped) return;
        if (r.ok) { zip.file(f.rel, new Uint8Array(await r.blob.arrayBuffer()), f.mtime); put++; }
        else skipped.push(`${f.rel} —— ${r.msg || '读取失败'}`);
        done++; got += f.size; show();
      }
    }
    await Promise.all(Array.from({ length: AT_ONCE }, worker));
    if (stopped) { say(`已取消下载 ${name}`); return; }
    if (skipped.length) zip.file(SKIPPED, new TextEncoder().encode(`下载 ${path} 时没有打包进来的：\r\n\r\n${skipped.join('\r\n')}\r\n`), Date.now());
    save(zip.blob(), name + '.zip');
    say(`已下载 ${name}.zip（${put} 个文件，${fmtSize(zip.size)}）` +
      (skipped.length ? `；有 ${skipped.length} 项没能打包，见压缩包里的「${SKIPPED}」` : ''));
  }
}

// every folder under the top one, breadth first: { files: [{ path, rel, size, mtime }], dirs: [{ rel, mtime }],
// skipped: ['rel —— why'], bytes, over }; null when stopped. rel: the path in the zip, from the folder's own name.
async function walk(machine, top, entry, stopped, say) {
  const files = [], dirs = [], skipped = [], seen = new Set();
  const clean = (n) => n.replace(/\\/g, '_');       // (a "\" in a Linux name would be a folder in the zip)
  const queue = [{ path: top, rel: clean(entry.name), mtime: entry.mtime }];
  let bytes = 0;
  while (queue.length) {
    if (stopped()) return null;
    const d = queue.shift();
    const r = await fsc.list(machine, d.path);
    if (!r.ok) {
      if (!dirs.length) throw new Error(r.msg || '打不开这个文件夹');
      skipped.push(`${d.rel}/ —— ${r.msg || '打不开'}`); continue;
    }
    if (seen.has(r.path)) { skipped.push(`${d.rel}/ —— 链接到已经打包的文件夹`); continue; }
    seen.add(r.path);
    dirs.push({ rel: d.rel, mtime: d.mtime });
    if (r.truncated) skipped.push(`${d.rel}/ —— 超过 5000 项，只打包了前 5000 项`);
    for (const e of r.entries) {
      const p = rpath.join(r.path, e.name), rel = d.rel + '/' + clean(e.name);
      if (e.dir) queue.push({ path: p, rel, mtime: e.mtime });
      else if (e.size > FILE_MAX) skipped.push(`${rel} —— 超过 100 MB（${fmtSize(e.size)}）`);
      else {
        files.push({ path: p, rel, size: e.size, mtime: e.mtime });
        bytes += e.size;
        if (files.length > MAX_FILES || bytes > MAX_BYTES) return { files, dirs, skipped, bytes, over: true };
      }
    }
    say(`清点 ${entry.name}：${files.length} 个文件，${fmtSize(bytes)}…`);
  }
  return { files, dirs, skipped, bytes, over: false };
}
