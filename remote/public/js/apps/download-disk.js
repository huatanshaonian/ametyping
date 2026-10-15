// Downloads written straight to this device's disk as they come (Chrome / Edge on a computer: the File System Access
// API), so nothing holds a whole file and there is no size limit: a file over 100 MB, a folder over what a .zip made in
// the page can hold (download-folder.js). Where the connection drops halfway -- the page's socket, or the computer's
// agent -- the download waits for it to come back and carries on from the byte it had got to (the agent reads from
// there: fs.js's from). A file changed on the computer meanwhile is not patched together: it fails.
import * as fsc from '../fs.js';
import { CUT, WAIT, online, pause } from '../fs-retry.js';
import { size as fmtSize } from '../filetypes.js';

export const canSaveToDisk = () => typeof window.showSaveFilePicker === 'function' && typeof window.showDirectoryPicker === 'function';
export const PICK = { id: 'ame-download', startIn: 'downloads' };          // (the picker remembers where it was last)

// one remote file into a FileSystemWritableFileStream (left open: the caller closes or aborts it).
// progress(bytes so far, size); waiting(text) while it waits to carry on. -> { promise -> { ok, size } | { ok:false, msg }, cancel }
export function pull(machine, path, out, progress, waiting) {
  let stopped = false, job = null, written = 0, info = null;
  const isStopped = () => stopped;
  async function run() {
    for (let tries = 0; ; tries++) {
      const from = written;
      job = fsc.read(machine, path, (got, size) => progress(from + got, size), '', {
        dl: true, from,
        start: async (i) => {
          if (info && (i.size !== info.size || i.mtime !== info.mtime)) throw new Error('文件在下载过程中被改动了');
          info = i;
          if (i.from !== written) { await out.truncate(i.from); written = i.from; }   // (an agent that cannot resume: from 0 again)
          await out.seek(i.from);
        },
        sink: async (bytes) => { await out.write(bytes); written += bytes.length; },
      });
      const r = await job.promise;
      if (stopped) return { ok: false, msg: '已取消' };
      if (r.ok) return { ok: true, size: written };
      if (r.local || !CUT.test(r.msg || '') || tries >= WAIT.length) return r;
      waiting(`${r.msg}，等连上后从 ${fmtSize(written)} 处接着下载…`);
      await online(isStopped);
      await pause(WAIT[tries], isStopped);
      if (stopped) return { ok: false, msg: '已取消' };
    }
  }
  return { promise: run(), cancel: () => { stopped = true; if (job) job.cancel(); } };
}

// a single file: asks where to save it (call it from the click itself: the browser only shows a picker then)
export function saveFile(machine, path, entry, say) {
  let stopped = false, p = null;
  const promise = (async () => {
    let fh;
    try { fh = await window.showSaveFilePicker({ ...PICK, suggestedName: entry.name }); }
    catch (e) { say(e && e.name === 'AbortError' ? '没有下载（没选保存位置）' : `${entry.name}：${(e && e.message) || '不能保存'}`); return; }
    if (stopped) return say('已取消下载');
    const out = await fh.createWritable();
    p = pull(machine, path, out, (got, size) => say(`下载 ${entry.name}… ${fmtSize(got)}${size ? ' / ' + fmtSize(size) : ''}`), say);
    if (stopped) p.cancel();
    const r = await p.promise;
    if (!r.ok) { try { await out.abort(); } catch {} say(r.msg === '已取消' ? '已取消下载' : `${entry.name}：${r.msg || '下载失败'}`); return; }
    await out.close();
    say(`已保存 ${fh.name}（${fmtSize(r.size)}）`);
  })().catch((e) => say(`${entry.name}：${(e && e.message) || '保存失败'}`));
  return { promise, cancel: () => { stopped = true; if (p) p.cancel(); } };
}

// a name Windows takes for a file (a Linux one may have : ? * in it, or end in a dot)
const fsName = (n) => n.replace(/[<>:"|?*\\/\u0000-\u001f]/g, '_').replace(/[. ]+$/, (m) => '_'.repeat(m.length)) || '_';
const exists = async (dir, name) => { try { await dir.getDirectoryHandle(name); return true; } catch { try { await dir.getFileHandle(name); return true; } catch { return false; } } };

// a folder walked already (download-folder.js's walk) into a folder picked here: <name> inside it ("<name> (2)" when
// there is one), what could not be had named in "<name> 未下载的文件.txt" beside it.
// -> { promise -> { ok, files, bytes, skipped, as } , cancel }
export function saveTree(machine, parent, all, say, AT_ONCE = 3) {
  const { files, dirs, skipped, bytes } = all;
  let stopped = false;
  const running = new Set();
  const promise = (async () => {
    const top = fsName(dirs[0].rel);
    let as = top;
    for (let k = 2; await exists(parent, as); k++) as = `${top} (${k})`;
    const handles = new Map();
    const dirOf = async (rel) => {
      if (handles.has(rel)) return handles.get(rel);
      const i = rel.lastIndexOf('/');
      const h = i < 0 ? await parent.getDirectoryHandle(as, { create: true }) : await (await dirOf(rel.slice(0, i))).getDirectoryHandle(fsName(rel.slice(i + 1)), { create: true });
      handles.set(rel, h);
      return h;
    };
    for (const d of dirs) { if (stopped) break; try { await dirOf(d.rel); } catch (e) { skipped.push(`${d.rel}/ —— ${(e && e.message) || '建不了文件夹'}`); } }
    const partial = new Map();
    let next = 0, done = 0, got = 0, put = 0;
    const show = () => { let g = got; for (const v of partial.values()) g += v; say(`下载 ${top}：${done} / ${files.length} 个文件，${fmtSize(g)} / ${fmtSize(bytes)}`); };
    show();
    async function worker() {
      while (!stopped && next < files.length) {
        const f = files[next++], key = {};
        const i = f.rel.lastIndexOf('/'), name = fsName(f.rel.slice(i + 1));
        let dir = null, out = null;
        try {
          dir = await dirOf(f.rel.slice(0, i));
          out = await (await dir.getFileHandle(name, { create: true })).createWritable();
        } catch (e) { skipped.push(`${f.rel} —— ${(e && e.message) || '建不了文件'}`); done++; got += f.size; show(); continue; }
        const p = pull(machine, f.path, out, (g) => { partial.set(key, g); show(); }, (msg) => say(`${f.rel}：${msg}`));
        running.add(p);
        const r = await p.promise;
        running.delete(p); partial.delete(key);
        if (r.ok) { await out.close(); put++; }
        else {
          try { await out.abort(); } catch {}
          try { await dir.removeEntry(name); } catch {}           // (no empty file left where one failed)
          if (!stopped) skipped.push(`${f.rel} —— ${r.msg || '下载失败'}`);
        }
        done++; got += f.size; show();
      }
    }
    await Promise.all(Array.from({ length: AT_ONCE }, worker));
    if (stopped) return { ok: false, msg: '已取消', as };
    if (skipped.length) {
      try {
        const w = await (await parent.getFileHandle(fsName(`${as} 未下载的文件.txt`), { create: true })).createWritable();
        await w.write(new TextEncoder().encode(`下载 ${all.path} 时没有下载下来的：\r\n\r\n${skipped.join('\r\n')}\r\n`)); await w.close();
      } catch {}
    }
    return { ok: true, files: put, bytes: got, skipped: skipped.length, as };
  })();
  return { promise, cancel: () => { stopped = true; for (const p of running) p.cancel(); } };
}
