// pdf.js (Mozilla's PDF renderer, public/vendor/pdfjs -- pdfjs-dist copied as is, see its VERSION) needs more than the
// plain one-level files the page's own STATIC rule allows: .mjs modules, and the character maps and standard fonts
// Chinese PDFs need, in folders. Served after the login check:
//   /vendor/pdfjs/pdf.min.mjs, pdf.worker.min.mjs, cmaps/<name>.bcmap, standard_fonts/<name>.(pfb|ttf), and the plain-JS
//   image decoders wasm/*_nowasm_fallback.js (WebAssembly would need the CSP loosened; the viewer asks for these)
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', 'public', 'vendor', 'pdfjs');
const FILES = /^\/vendor\/pdfjs\/(pdf(?:\.worker)?\.min\.mjs|cmaps\/[A-Za-z0-9_.-]+\.bcmap|standard_fonts\/[A-Za-z0-9_.-]+\.(?:pfb|ttf)|wasm\/[a-z0-9_]+_nowasm_fallback\.js)$/;
const TYPES = { '.mjs': 'text/javascript; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.bcmap': 'application/octet-stream', '.pfb': 'application/octet-stream', '.ttf': 'font/ttf' };

// true when the request was one of these (answered)
function serveVendor(req, res, p, send) {
  const m = req.method === 'GET' && FILES.exec(p);
  if (!m) return false;
  const f = path.join(ROOT, m[1]);
  fs.readFile(f, (e, buf) => (e ? send(res, 404, 'not found') : send(res, 200, buf, TYPES[path.extname(f)] || 'application/octet-stream', { 'Cache-Control': 'max-age=604800' })));
  return true;
}

module.exports = { serveVendor };
