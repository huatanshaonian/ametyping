// 我的电脑's 上传: files from this device into the folder open in the explorer, one after another (fs-upload.js does
// one). A file of the same name there is replaced only when the user says so; say(text) tells how far it has got;
// uploaded(name) after each one in (the explorer lists the folder again).
// -> { promise (settles when all are through, whichever way), cancel }
import { upload } from '../fs-upload.js';
import { size as fmtSize } from '../filetypes.js';
import { confirmBox } from '../dialog.js';

export function uploadFiles(machine, dir, files, say, uploaded) {
  let stopped = false, job = null;
  const promise = (async () => {
    let put = 0;
    const failed = [];
    for (let i = 0; i < files.length && !stopped; i++) {
      const f = files[i], nth = files.length > 1 ? `（${i + 1}/${files.length}）` : '';
      let t0 = Date.now(), b0 = null;
      const progress = (have, size, checking) => {
        if (checking) return say(`上传 ${f.name}${nth}：传完了，那台电脑在校验…`);
        if (b0 == null || have < b0) { b0 = have; t0 = Date.now(); }        // (speed: from where this go started)
        const s = (Date.now() - t0) / 1000, rate = s > 1 ? ` · ${fmtSize((have - b0) / s)}/s` : '';
        say(`上传 ${f.name}${nth}：${fmtSize(have)} / ${fmtSize(size)}${rate}`);
      };
      const go = (overwrite) => { job = upload(machine, dir, f, { overwrite, progress, waiting: (m) => say(`上传 ${f.name}${nth}：${m}`) }); return job.promise; };
      let r = await go(false);
      if (!r.ok && r.exists && !stopped) {
        const yes = await confirmBox(`「${f.name}」在 ${dir} 里已经有了。\n用这台设备上的这个（${fmtSize(f.size)}）替换它吗？`, { title: '上传', ok: '替换', cancel: '跳过', danger: true });
        r = yes && !stopped ? await go(true) : { ok: false, msg: '已跳过' };
      }
      job = null;
      if (stopped) break;
      if (r.ok) { put++; uploaded(f.name); } else failed.push(`${f.name}（${r.msg || '失败'}）`);
    }
    if (stopped) return say('已取消上传' + (put ? `（之前的 ${put} 个已经传好）` : ''));
    say((put ? `已上传 ${put} 个文件到 ${dir}` : '没有上传文件') + (failed.length ? `；没传成的：${failed.slice(0, 3).join('、')}${failed.length > 3 ? ` 等 ${failed.length} 个` : ''}` : ''));
  })();
  return { promise, cancel: () => { stopped = true; if (job) job.cancel(); } };
}
