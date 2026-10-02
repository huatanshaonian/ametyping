// A small real PDF for the tests: one page per text (Helvetica, one line each), offsets in the xref table computed.
'use strict';

function makePdf(pages) {
  const objs = [];
  const add = (s) => { objs.push(s); return objs.length; };
  const catalog = add(null), tree = add(null), font = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>');
  const kids = pages.map((text) => {
    const esc = String(text).replace(/[\\()]/g, '\\$&');
    const stream = `BT /F1 28 Tf 72 700 Td (${esc}) Tj ET`;
    const content = add(`<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`);
    return add(`<< /Type /Page /Parent ${tree} 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 ${font} 0 R >> >> /Contents ${content} 0 R >>`);
  });
  objs[catalog - 1] = `<< /Type /Catalog /Pages ${tree} 0 R >>`;
  objs[tree - 1] = `<< /Type /Pages /Kids [${kids.map((k) => k + ' 0 R').join(' ')}] /Count ${kids.length} >>`;
  let out = '%PDF-1.4\n';
  const at = [];
  objs.forEach((o, i) => { at.push(out.length); out += `${i + 1} 0 obj\n${o}\nendobj\n`; });
  const xref = out.length;
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n` + at.map((x) => String(x).padStart(10, '0') + ' 00000 n \n').join('');
  out += `trailer\n<< /Size ${objs.length + 1} /Root ${catalog} 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
}

module.exports = { makePdf };
