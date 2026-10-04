// Renders a PDF's pages to PNG for the models to read (vision.js runs it as a child process: pdf.js and the native
// canvas stay out of the server, and a page that crashes them takes down only this run).
//   node pages.mjs <pdf> <outDir> <width> <pages: "1,2,5" | "count">
// Prints one JSON line: { n: the page count, files: [{ page, file, w, h }] }. A whole page at 1600 px reads well: a
// dense 1987 two-column scan came back with every subscript and prime of its equations (halves were no better).
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

const [pdfPath, outDir, widthArg, pagesArg] = process.argv.slice(2);
const require = createRequire(import.meta.url);
const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
// the fonts, character maps and the image decoders pdf.js loads as it goes (without them: blank pages)
const base = pathToFileURL(path.dirname(require.resolve('pdfjs-dist/package.json')) + '/').href;
const task = pdfjs.getDocument({ data: new Uint8Array(fs.readFileSync(pdfPath)), isEvalSupported: false, verbosity: 0,
  standardFontDataUrl: base + 'standard_fonts/', cMapUrl: base + 'cmaps/', cMapPacked: true, wasmUrl: base + 'wasm/' });
const doc = await task.promise;
const out = { n: doc.numPages, files: [] };
if (pagesArg !== 'count') {
  const width = Math.min(3000, Math.max(400, +widthArg || 1600));
  for (const n of pagesArg.split(',').map(Number).filter((x) => x >= 1 && x <= doc.numPages)) {
    const page = await doc.getPage(n);
    const vp = page.getViewport({ scale: width / page.getViewport({ scale: 1 }).width });
    const w = Math.ceil(vp.width), h = Math.ceil(vp.height);
    const cc = doc.canvasFactory.create(w, h);
    cc.context.fillStyle = '#fff'; cc.context.fillRect(0, 0, w, h);
    await page.render({ canvasContext: cc.context, viewport: vp }).promise;
    const file = path.join(outDir, `p${n}.png`);
    fs.writeFileSync(file, cc.canvas.toBuffer('image/png'));
    out.files.push({ page: n, file, w, h });
    page.cleanup();
  }
}
await task.destroy();
process.stdout.write(JSON.stringify(out) + '\n');
