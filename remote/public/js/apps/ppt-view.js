// A PowerPoint deck (.pptx .pptm .ppsx .potx) in the viewer (viewer.js), drawn by vendor/pptx-renderer (an ES module,
// imported the first time one is opened): the slides one under another on grey as in the PDF viewer, each fitted to the
// window's width -- text, shapes, pictures, tables, charts, SmartArt. Slides are drawn as they scroll into sight (a long
// deck does not draw all at once). Limits on what the file may unpack to (the library's recommended ones for files from
// elsewhere); links only to the web, mail or other slides; embedded video and sound are not played (the page's rules
// keep media to this server), and PDF.js previews of pasted vector art (EMF) are off (they would need blob workers).
import { h } from '../util.js';

const LIB = '/vendor/pptx-renderer/aiden0z-pptx-renderer.browser.es.js';
let loading = null;
function load() {
  if (!loading) { loading = import(LIB); loading.catch(() => { loading = null; }); }
  return loading;
}

// into wrap (empty, the scrolling box); -> { slides, info(), onInfo[], destroy() } -- info(): what the bar says
export async function renderDeck(wrap, buf) {
  const { PptxViewer, RECOMMENDED_ZIP_LIMITS } = await load();
  const box = h('div', { class: 'ppt-slides' });
  wrap.replaceChildren(box);
  const onInfo = [];
  let cur = 0;
  const viewer = await PptxViewer.open(buf, box, {
    zipLimits: RECOMMENDED_ZIP_LIMITS, fitMode: 'contain', scrollContainer: wrap, lazyMedia: true, lazySlides: true, pdfjs: false,
    listOptions: { windowed: true, initialSlides: 3, batchSize: 4 },
    onSlideChange: (i) => { cur = i; for (const f of onInfo) f(); },
  });
  const slides = viewer.slideCount;
  const info = () => (slides > 1 ? `第 ${cur + 1} / ${slides} 张` : `${slides} 张幻灯片`);
  return { slides, info, onInfo, destroy: () => viewer.destroy() };
}
