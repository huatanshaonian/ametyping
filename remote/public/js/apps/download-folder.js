// A remote folder saved to this device (我的电脑's 下载 with a folder picked). First every folder in it is listed
// through the agent, as the explorer lists one, to count what there is. Then:
// - small enough -- at most MAX_FILES files and MAX_BYTES, none over the agent's 100 MB: <name>.zip, made here
//   (zip.js; the page holds it all until it is handed over) from the files read a few at a time as download.js reads
//   one, the folders as they were, empty ones too;
// - larger, in a browser that can write to disk (Chrome / Edge on a computer): the status line asks for a folder on
//   this device to save it into (a picker only opens from a click), and it is written there file by file as it comes,
//   with no limit, carrying on after a cut (download-disk.js);
// - larger, elsewhere: a zip without the files over 100 MB, or nothing when even that is too much.
// What cannot come along -- a file the agent refuses or cannot read, a folder of more than 5 000 entries (only those
// listed), a link back into a folder already taken -- is left out, and named in a text file beside the folder.
// say(text, action?) tells how far it has got; action: { label, run } for a button beside the text.
// -> { promise (settles when it is over, whichever way), cancel }
import * as fsc from '../fs.js';
import * as rpath from '../rpath.js';
import { size as fmtSize } from '../filetypes.js';
import { createZip } from './zip.js';
import { save } from './download.js';
import { canSaveToDisk, saveTree, PICK } from './download-disk.js';

const MAX_FILES = 10000;                  // a zip made in the page: files ...
const MAX_BYTES = 1024 * 1024 * 1024;     // ... and bytes
const FILE_MAX = 100 * 1024 * 1024;       // (what the agent will read into the page: agent/files.js)
const WALK_MAX = 200000;                  // files counted before giving up (a whole drive picked by mistake)
const AT_ONCE = 3;                        // files read at the same time
const SKIPPED = '未打包的文件.txt';

export function downloadFolder(machine, path, entry, say) {
  const name = entry.name;
  let stopped = false, picking = null;
  const running = new Set();
  const cancel = () => { stopped = true; for (const j of running) j.cancel(); if (picking) picking(null); };
  const promise = run().catch((e) => say(`${name}：${(e && e.message) || '下载失败'}`));
  return { promise, cancel };

  async function run() {
    say(`清点 ${name}…`);
    const all = await walk(machine, path, entry, () => stopped, say);
    if (stopped) return say(`已取消下载 ${name}`);
    if (all.over) return say(`${name} 里的文件太多（超过 ${WALK_MAX} 个），请选里面小一些的文件夹下载`);
    const big = all.files.filter((f) => f.size > FILE_MAX);
    const bigBytes = big.reduce((n, f) => n + f.size, 0);
    if (!big.length && all.files.length <= MAX_FILES && all.bytes <= MAX_BYTES) return zipUp(all);
    if (canSaveToDisk()) return toDisk(all, big);
    if (all.files.length - big.length > MAX_FILES || all.bytes - bigBytes > MAX_BYTES)
      return say(`${name} 太大了（${all.files.length} 个文件，${fmtSize(all.bytes)}），这个浏览器里打包不了；电脑上的 Chrome 或 Edge 可以直接存成文件夹`);
    for (const f of big) all.skipped.push(`${f.rel} —— 超过 100 MB（${fmtSize(f.size)}；电脑上的 Chrome 或 Edge 能下载）`);
    return zipUp({ ...all, files: all.files.filter((f) => f.size <= FILE_MAX), bytes: all.bytes - bigBytes });
  }

  async function zipUp({ files, dirs, skipped, bytes }) {
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
    if (stopped) return say(`已取消下载 ${name}`);
    if (skipped.length) zip.file(SKIPPED, new TextEncoder().encode(`下载 ${path} 时没有打包进来的：\r\n\r\n${skipped.join('\r\n')}\r\n`), Date.now());
    save(zip.blob(), name + '.zip');
    say(`已下载 ${name}.zip（${put} 个文件，${fmtSize(zip.size)}）` +
      (skipped.length ? `；有 ${skipped.length} 项没能打包，见压缩包里的「${SKIPPED}」` : ''));
  }

  async function toDisk(all, big) {
    const why = big.length ? `有 ${big.length} 个文件超过 100 MB` : `共 ${all.files.length} 个文件、${fmtSize(all.bytes)}`;
    const parent = await new Promise((resolve) => {
      picking = resolve;
      const ask = (pre = '') => say(`${pre}${name}：${why}，打不成 .zip，可以直接存进这台电脑上的一个文件夹（在里面新建「${name}」）`, {
        label: '选择保存位置…',
        run: async () => {
          try { resolve(await window.showDirectoryPicker({ ...PICK, mode: 'readwrite' })); }
          catch (e) { ask(e && e.name === 'AbortError' ? '' : `存不了那里（${(e && e.message) || e}）。`); }
        },
      });
      ask();
    });
    picking = null;
    if (stopped || !parent) return say(`已取消下载 ${name}`);
    const t = saveTree(machine, parent, { ...all, path }, say, AT_ONCE);
    running.add(t);
    const r = await t.promise;
    if (!r.ok) return say(r.msg === '已取消' ? `已取消下载 ${name}（「${r.as}」里是已经下载的部分）` : `${name}：${r.msg || '下载失败'}`);
    say(`已下载到「${r.as}」（${r.files} 个文件，${fmtSize(r.bytes)}）` + (r.skipped ? `；有 ${r.skipped} 项没下载下来，见旁边的「${r.as} 未下载的文件.txt」` : ''));
  }
}

// every folder under the top one, breadth first: { files: [{ path, rel, size, mtime }], dirs: [{ rel, mtime }],
// skipped: ['rel —— why'], bytes, over }; null when stopped. rel: the path from the folder's own name, "/" between.
async function walk(machine, top, entry, stopped, say) {
  const files = [], dirs = [], skipped = [], seen = new Set();
  const clean = (n) => n.replace(/\\/g, '_');       // (a "\" in a Linux name would be a folder in a zip)
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
    if (seen.has(r.path)) { skipped.push(`${d.rel}/ —— 链接到已经下载的文件夹`); continue; }
    seen.add(r.path);
    dirs.push({ rel: d.rel, mtime: d.mtime });
    if (r.truncated) skipped.push(`${d.rel}/ —— 超过 5000 项，只下载了前 5000 项`);
    for (const e of r.entries) {
      const p = rpath.join(r.path, e.name), rel = d.rel + '/' + clean(e.name);
      if (e.dir) queue.push({ path: p, rel, mtime: e.mtime });
      else {
        files.push({ path: p, rel, size: e.size, mtime: e.mtime });
        bytes += e.size;
        if (files.length > WALK_MAX) return { files, dirs, skipped, bytes, over: true };
      }
    }
    say(`清点 ${entry.name}：${files.length} 个文件，${fmtSize(bytes)}…`);
  }
  return { files, dirs, skipped, bytes, over: false };
}
