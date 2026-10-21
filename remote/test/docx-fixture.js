// A small Word document for the viewer's test (ui-files.js), put together from its XML parts as Word lays them out:
// a bold heading, a paragraph, a 2×2 table, a picture, a web link, a javascript: link (must not stay a link), a page
// break and a second page.
const { createZip } = require('../public/js/apps/zip.js');

const W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" ' +
  'xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" ' +
  'xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture"';
const run = (t, rpr = '') => `<w:r>${rpr ? `<w:rPr>${rpr}</w:rPr>` : ''}<w:t xml:space="preserve">${t}</w:t></w:r>`;
const p = (inner) => `<w:p>${inner}</w:p>`;
const cell = (t) => `<w:tc><w:tcPr><w:tcW w:w="2400" w:type="dxa"/></w:tcPr>${p(run(t))}</w:tc>`;
const border = '<w:tblBorders>' + ['top', 'left', 'bottom', 'right', 'insideH', 'insideV'].map((s) => `<w:${s} w:val="single" w:sz="4" w:space="0" w:color="000000"/>`).join('') + '</w:tblBorders>';
const EMU = 9525 * 32;                                    // a 32 px picture
const picture = `<w:r><w:drawing><wp:inline><wp:extent cx="${EMU}" cy="${EMU}"/><wp:docPr id="1" name="图"/><a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture">` +
  `<pic:pic><pic:nvPicPr><pic:cNvPr id="1" name="mesh.png"/><pic:cNvPicPr/></pic:nvPicPr><pic:blipFill><a:blip r:embed="rIdImg"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill>` +
  `<pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${EMU}" cy="${EMU}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr></pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r>`;

async function makeDocx(png) {
  const body = [
    p(run('网格加密报告', '<w:b/><w:sz w:val="40"/>')),
    p(run('这是正文段落，界面两侧各加密 5 层。')),
    `<w:tbl><w:tblPr><w:tblW w:w="4800" w:type="dxa"/>${border}</w:tblPr><w:tblGrid><w:gridCol w:w="2400"/><w:gridCol w:w="2400"/></w:tblGrid>` +
      `<w:tr>${cell('参数')}${cell('值')}</w:tr><w:tr>${cell('dx')}${cell('1e-3')}</w:tr></w:tbl>`,
    p(picture),
    p(`<w:hyperlink r:id="rIdWeb">${run('外部链接')}</w:hyperlink>${run(' 和 ')}<w:hyperlink r:id="rIdBad">${run('坏链接')}</w:hyperlink>`),
    p('<w:r><w:br w:type="page"/></w:r>'),
    p(run('第二页的内容')),
    '<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440" w:header="720" w:footer="720" w:gutter="0"/></w:sectPr>',
  ].join('');
  const parts = {
    '[Content_Types].xml': '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
      '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Default Extension="png" ContentType="image/png"/>' +
      '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>',
    '_rels/.rels': '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
      '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>',
    'word/_rels/document.xml.rels': '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
      '<Relationship Id="rIdImg" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/mesh.png"/>' +
      '<Relationship Id="rIdWeb" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="https://example.com/report" TargetMode="External"/>' +
      '<Relationship Id="rIdBad" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="javascript:alert(1)" TargetMode="External"/></Relationships>',
    'word/document.xml': `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document ${W}><w:body>${body}</w:body></w:document>`,
  };
  const z = createZip(), when = Date.now();
  for (const [name, text] of Object.entries(parts)) z.file(name, Buffer.from(text), when);
  z.file('word/media/mesh.png', png, when);
  return Buffer.from(await z.blob().arrayBuffer());
}

module.exports = { makeDocx };
