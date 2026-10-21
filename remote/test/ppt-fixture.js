// A small PowerPoint deck for the viewer's test (ui-files.js), put together from its XML parts as PowerPoint lays them
// out (a master, a layout, a theme and three slides): 1 -- a title and a filled shape with text; 2 -- a 2×2 table, a
// picture, a web link and a javascript: one (must not be followed); 3 -- text that looks like HTML (shown as text).
const { createZip } = require('../public/js/apps/zip.js');

const NS = 'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" ' +
  'xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"';
const X = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';
const REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/';
const rels = (list) => X + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
  list.map(([id, type, target, ext]) => `<Relationship Id="${id}" Type="${REL}${type}" Target="${target}"${ext ? ' TargetMode="External"' : ''}/>`).join('') + '</Relationships>';
const W = 9144000, H = 5143500;                      // 16:9, in EMU
const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const xfrm = (x, y, w, h) => `<a:xfrm><a:off x="${x}" y="${y}"/><a:ext cx="${w}" cy="${h}"/></a:xfrm>`;
const run = (t, attrs = '', link = '') => `<a:r><a:rPr lang="zh-CN" ${attrs}>${link ? `<a:hlinkClick r:id="${link}"/>` : ''}</a:rPr><a:t>${esc(t)}</a:t></a:r>`;
const text = (paras) => `<p:txBody><a:bodyPr wrap="square"/><a:lstStyle/>${paras.map((p) => `<a:p>${p}</a:p>`).join('')}</p:txBody>`;
const shape = (id, name, box, paras, fill = '') => `<p:sp><p:nvSpPr><p:cNvPr id="${id}" name="${name}"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr>` +
  `<p:spPr>${box}<a:prstGeom prst="rect"><a:avLst/></a:prstGeom>${fill}</p:spPr>${text(paras)}</p:sp>`;
const tree = (inner) => '<p:cSld><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr/>' + inner + '</p:spTree></p:cSld>';
const cell = (t) => `<a:tc><a:txBody><a:bodyPr/><a:lstStyle/><a:p>${run(t, 'sz="1600"')}</a:p></a:txBody><a:tcPr>` +
  ['lnL', 'lnR', 'lnT', 'lnB'].map((l) => `<a:${l} w="12700"><a:solidFill><a:srgbClr val="000000"/></a:solidFill></a:${l}>`).join('') + '</a:tcPr></a:tc>';
const EMU = 9525 * 64;                                // a 64 px picture

const THEME = X + `<a:theme ${NS} name="t"><a:themeElements><a:clrScheme name="c">` +
  [['dk1', '000000'], ['lt1', 'FFFFFF'], ['dk2', '1F497D'], ['lt2', 'EEECE1'], ['accent1', '4F81BD'], ['accent2', 'C0504D'], ['accent3', '9BBB59'], ['accent4', '8064A2'],
    ['accent5', '4BACC6'], ['accent6', 'F79646'], ['hlink', '0000FF'], ['folHlink', '800080']].map(([k, v]) => `<a:${k}><a:srgbClr val="${v}"/></a:${k}>`).join('') +
  '</a:clrScheme><a:fontScheme name="f"><a:majorFont><a:latin typeface="Calibri"/><a:ea typeface=""/><a:cs typeface=""/></a:majorFont>' +
  '<a:minorFont><a:latin typeface="Calibri"/><a:ea typeface=""/><a:cs typeface=""/></a:minorFont></a:fontScheme><a:fmtScheme name="m">' +
  '<a:fillStyleLst><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:fillStyleLst>' +
  '<a:lnStyleLst><a:ln w="9525"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln><a:ln w="9525"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln><a:ln w="9525"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln></a:lnStyleLst>' +
  '<a:effectStyleLst><a:effectStyle><a:effectLst/></a:effectStyle><a:effectStyle><a:effectLst/></a:effectStyle><a:effectStyle><a:effectLst/></a:effectStyle></a:effectStyleLst>' +
  '<a:bgFillStyleLst><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:bgFillStyleLst>' +
  '</a:fmtScheme></a:themeElements></a:theme>';
const MASTER = X + `<p:sldMaster ${NS}>${tree('')}<p:clrMap bg1="lt1" tx1="dk1" bg2="lt2" tx2="dk2" accent1="accent1" accent2="accent2" accent3="accent3" accent4="accent4" accent5="accent5" accent6="accent6" hlink="hlink" folHlink="folHlink"/>` +
  '<p:sldLayoutIdLst><p:sldLayoutId id="2147483649" r:id="rId1"/></p:sldLayoutIdLst></p:sldMaster>';
const LAYOUT = X + `<p:sldLayout ${NS} type="blank">${tree('')}<p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sldLayout>`;
const slide = (inner) => X + `<p:sld ${NS}>${tree(inner)}<p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sld>`;

const SLIDES = [
  slide(shape(2, '标题', xfrm(457200, 457200, 8229600, 914400), [run('网格加密汇报', 'sz="4000" b="1"')]) +
    shape(3, '方框', xfrm(457200, 1828800, 4572000, 1371600), [run('界面两侧各加密 5 层', 'sz="2000"')], '<a:solidFill><a:srgbClr val="FFD966"/></a:solidFill>')),
  slide('<p:graphicFrame><p:nvGraphicFramePr><p:cNvPr id="2" name="表"/><p:cNvGraphicFramePr/><p:nvPr/></p:nvGraphicFramePr>' + xfrm(457200, 457200, 3657600, 741680).replace(/a:xfrm/g, 'p:xfrm') +
    '<a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/table"><a:tbl><a:tblPr/><a:tblGrid><a:gridCol w="1828800"/><a:gridCol w="1828800"/></a:tblGrid>' +
    `<a:tr h="370840">${cell('参数')}${cell('值')}</a:tr><a:tr h="370840">${cell('dx')}${cell('1e-3')}</a:tr></a:tbl></a:graphicData></a:graphic></p:graphicFrame>` +
    `<p:pic><p:nvPicPr><p:cNvPr id="3" name="图"/><p:cNvPicPr/><p:nvPr/></p:nvPicPr><p:blipFill><a:blip r:embed="rIdImg"/><a:stretch><a:fillRect/></a:stretch></p:blipFill>` +
    `<p:spPr>${xfrm(5486400, 457200, EMU, EMU)}<a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr></p:pic>` +
    shape(4, '链接', xfrm(457200, 2743200, 8229600, 457200), [run('外部链接', 'sz="1800"', 'rIdWeb') + run(' 和 ', 'sz="1800"') + run('坏链接', 'sz="1800"', 'rIdBad')])),
  slide(shape(2, '正文', xfrm(457200, 457200, 8229600, 914400), [run('<img src=x onerror=alert(1)>', 'sz="2400"')])),
];

async function makePptx(png) {
  const parts = {
    '[Content_Types].xml': X + '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
      '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Default Extension="png" ContentType="image/png"/>' +
      '<Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/>' +
      '<Override PartName="/ppt/slideMasters/slideMaster1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideMaster+xml"/>' +
      '<Override PartName="/ppt/slideLayouts/slideLayout1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideLayout+xml"/>' +
      '<Override PartName="/ppt/theme/theme1.xml" ContentType="application/vnd.openxmlformats-officedocument.theme+xml"/>' +
      SLIDES.map((_, i) => `<Override PartName="/ppt/slides/slide${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/>`).join('') + '</Types>',
    '_rels/.rels': rels([['rId1', 'officeDocument', 'ppt/presentation.xml']]),
    'ppt/presentation.xml': X + `<p:presentation ${NS}><p:sldMasterIdLst><p:sldMasterId id="2147483648" r:id="rIdM"/></p:sldMasterIdLst><p:sldIdLst>` +
      SLIDES.map((_, i) => `<p:sldId id="${256 + i}" r:id="rIdS${i + 1}"/>`).join('') + `</p:sldIdLst><p:sldSz cx="${W}" cy="${H}"/><p:notesSz cx="${H}" cy="${W}"/></p:presentation>`,
    'ppt/_rels/presentation.xml.rels': rels([['rIdM', 'slideMaster', 'slideMasters/slideMaster1.xml'], ['rIdT', 'theme', 'theme/theme1.xml'],
      ...SLIDES.map((_, i) => [`rIdS${i + 1}`, 'slide', `slides/slide${i + 1}.xml`])]),
    'ppt/slideMasters/slideMaster1.xml': MASTER,
    'ppt/slideMasters/_rels/slideMaster1.xml.rels': rels([['rId1', 'slideLayout', '../slideLayouts/slideLayout1.xml'], ['rId2', 'theme', '../theme/theme1.xml']]),
    'ppt/slideLayouts/slideLayout1.xml': LAYOUT,
    'ppt/slideLayouts/_rels/slideLayout1.xml.rels': rels([['rId1', 'slideMaster', '../slideMasters/slideMaster1.xml']]),
    'ppt/theme/theme1.xml': THEME,
  };
  SLIDES.forEach((s, i) => {
    parts[`ppt/slides/slide${i + 1}.xml`] = s;
    parts[`ppt/slides/_rels/slide${i + 1}.xml.rels`] = rels([['rId1', 'slideLayout', '../slideLayouts/slideLayout1.xml'],
      ...(i === 1 ? [['rIdImg', 'image', '../media/mesh.png'], ['rIdWeb', 'hyperlink', 'https://example.com/report', true], ['rIdBad', 'hyperlink', 'javascript:alert(1)', true]] : [])]);
  });
  const z = createZip(), when = Date.now();
  for (const [name, t] of Object.entries(parts)) z.file(name, Buffer.from(t), when);
  z.file('ppt/media/mesh.png', png, when);
  return Buffer.from(await z.blob().arrayBuffer());
}

module.exports = { makePptx };
