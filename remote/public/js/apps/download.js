// A remote file saved to this device (我的电脑's 下载): read in chunks through the agent (fs.js), as the viewer reads
// one, then handed to the browser as a download under its own name. say(text) tells how far it has got.
// A file over 100 MB, which the page would have to hold whole: written to disk as it comes, where the browser can
// (download-disk.js; a 另存为 dialog first). (A folder: download-folder.js.)
// -> { promise (settles when it is over, whichever way), cancel }
import * as fsc from '../fs.js';
import { mimeOf, size as fmtSize } from '../filetypes.js';
import { canSaveToDisk, saveFile } from './download-disk.js';

const MAX = 100 * 1024 * 1024;            // (what the agent will read into the page: agent/files.js)

export function download(machine, path, entry, say) {
  if (entry.size > MAX) {
    if (canSaveToDisk()) return saveFile(machine, path, entry, say);       // (written to disk as it comes: no limit)
    say(`${entry.name} 太大了（${fmtSize(entry.size)}），这个浏览器里只能下载 100 MB 以内的文件；电脑上的 Chrome 或 Edge 可以下载更大的`);
    return { promise: Promise.resolve(), cancel() {} };
  }
  say(`下载 ${entry.name}…`);
  const job = fsc.read(machine, path, (got, total) => say(`下载 ${entry.name}… ${fmtSize(got)}${total ? ' / ' + fmtSize(total) : ''}`), mimeOf(entry.name));
  const promise = job.promise.then((r) => {
    if (!r.ok) { say(`${entry.name}：${r.msg || '下载失败'}`); return; }
    save(r.blob, entry.name);
    say(`已下载 ${entry.name}（${fmtSize(r.size)}）`);
  });
  return { promise, cancel: job.cancel };
}

// hand a blob to the browser as a download
export function save(blob, name) {
  const url = URL.createObjectURL(blob);
  const a = Object.assign(document.createElement('a'), { href: url, download: name });
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60 * 1000);        // (the browser has taken it by then)
}
