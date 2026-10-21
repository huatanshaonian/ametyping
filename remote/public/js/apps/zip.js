// A .zip made in the browser (我的电脑's 下载 of a folder: download-folder.js). Stored, not compressed: the files have
// come over the network already, the zip only keeps them together -- and every unzip program, Windows' own included,
// opens it. Names are UTF-8 (flag bit 11), with "/" between folders; a folder is an entry of its own ("a/b/"), so an
// empty one is kept. No ZIP64: the caller keeps below 4 GB and 65 535 entries.
// No imports: the tests load this file as it is.

const TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; }
  return t;
})();
export function crc32(bytes, crc = 0) {
  let c = ~crc >>> 0;
  for (let i = 0; i < bytes.length; i++) c = TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return ~c >>> 0;
}

// MS-DOS date and time (local, two-second steps; nothing before 1980)
function dos(ms) {
  const d = new Date(ms || Date.now());
  if (d.getFullYear() < 1980) return { date: (1 << 5) | 1, time: 0 };
  return { date: ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(), time: (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1) };
}

// -> { dir(name, mtime), file(name, bytes, mtime), blob() -> Blob of the whole .zip, size (so far), count }
export function createZip() {
  const enc = new TextEncoder();
  const parts = [], central = [];
  let offset = 0, count = 0;
  function add(name, bytes, mtime, isDir) {
    const nm = enc.encode(name), { date, time } = dos(mtime);
    const crc = isDir ? 0 : crc32(bytes), size = isDir ? 0 : bytes.length;
    if (count >= 0xffff || offset + 30 + nm.length + size > 0xffffffff) throw new Error('太大了，打包不了');
    const head = new DataView(new ArrayBuffer(30));
    head.setUint32(0, 0x04034b50, true); head.setUint16(4, 20, true); head.setUint16(6, 0x0800, true); head.setUint16(8, 0, true);
    head.setUint16(10, time, true); head.setUint16(12, date, true); head.setUint32(14, crc, true);
    head.setUint32(18, size, true); head.setUint32(22, size, true); head.setUint16(26, nm.length, true); head.setUint16(28, 0, true);
    parts.push(head.buffer, nm);
    if (size) parts.push(new Blob([bytes]));          // (a Blob: the browser may keep it out of the page's memory)
    const cd = new DataView(new ArrayBuffer(46));
    cd.setUint32(0, 0x02014b50, true); cd.setUint16(4, 20, true); cd.setUint16(6, 20, true); cd.setUint16(8, 0x0800, true); cd.setUint16(10, 0, true);
    cd.setUint16(12, time, true); cd.setUint16(14, date, true); cd.setUint32(16, crc, true);
    cd.setUint32(20, size, true); cd.setUint32(24, size, true); cd.setUint16(28, nm.length, true);
    cd.setUint32(38, isDir ? 0x10 : 0, true);           // (MS-DOS attributes: 0x10 a folder)
    cd.setUint32(42, offset, true);
    central.push(cd.buffer, nm);
    offset += 30 + nm.length + size; count++;
  }
  return {
    dir: (name, mtime) => add(name.replace(/\/?$/, '/'), null, mtime, true),
    file: (name, bytes, mtime) => add(name, bytes, mtime, false),
    get size() { return offset; },
    get count() { return count; },
    blob() {
      const cdSize = central.reduce((n, p) => n + p.byteLength, 0);
      const end = new DataView(new ArrayBuffer(22));
      end.setUint32(0, 0x06054b50, true); end.setUint16(8, count, true); end.setUint16(10, count, true);
      end.setUint32(12, cdSize, true); end.setUint32(16, offset, true);
      return new Blob([...parts, ...central, end.buffer], { type: 'application/zip' });
    },
  };
}
