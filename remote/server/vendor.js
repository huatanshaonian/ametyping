// Third-party libraries copied as is under public/vendor/ (see each one's VERSION) that need more than the plain
// one-level files the page's own STATIC rule allows -- .mjs modules, fonts, folders. Served after the login check.
// pdf.js (Mozilla's PDF renderer) with the character maps and standard fonts Chinese PDFs need:
//   /vendor/pdfjs/pdf.min.mjs, pdf.worker.min.mjs, cmaps/<name>.bcmap, standard_fonts/<name>.(pfb|ttf), and the plain-JS
//   image decoders wasm/*_nowasm_fallback.js (WebAssembly would need the CSP loosened; the viewer asks for these)
// KaTeX (LaTeX formulas in Markdown): /vendor/katex/katex.mjs, katex.min.css, fonts/KaTeX_<name>.woff2
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', 'public', 'vendor');
const FILES = /^\/vendor\/(pdfjs\/(?:pdf(?:\.worker)?\.min\.mjs|cmaps\/[A-Za-z0-9_.-]+\.bcmap|standard_fonts\/[A-Za-z0-9_.-]+\.(?:pfb|ttf)|wasm\/[a-z0-9_]+_nowasm_fallback\.js)|katex\/(?:katex\.mjs|katex\.min\.css|fonts\/KaTeX_[A-Za-z0-9_-]+\.woff2))$/;
const TYPES = { '.mjs': 'text/javascript; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.woff2': 'font/woff2', '.bcmap': 'application/octet-stream', '.pfb': 'application/octet-stream', '.ttf': 'font/ttf' };

// true when the request was one of these (answered)
function serveVendor(req, res, p, send) {
  const m = req.method === 'GET' && FILES.exec(p);
  if (!m) return false;
  const f = path.join(ROOT, m[1]);
  fs.readFile(f, (e, buf) => (e ? send(res, 404, 'not found') : send(res, 200, buf, TYPES[path.extname(f)] || 'application/octet-stream', { 'Cache-Control': 'max-age=604800' })));
  return true;
}

module.exports = { serveVendor };
