// Sending a file of the page (scripts, styles, pictures) so that opening Windose again is cheap -- a phone throws the
// page away in the background and loads all of it anew, ~75 scripts and styles over the tailnet:
//   - an ETag (size + time changed) and "304 Not Modified" when the browser's copy is still that one. The scripts
//     stay "no-cache" (asked about every time, so a deploy shows at once), but asking costs a few bytes, not the file;
//   - text compressed (gzip) when the browser takes it; the compressed copy is kept while the file does not change.
'use strict';
const fs = require('fs');
const zlib = require('zlib');

const TEXT = /^(text\/|application\/(javascript|json|manifest\+json)|image\/svg)/;
const MIN_GZIP = 600;
const kept = new Map();                    // file -> { etag, gz } (the compressed copy of this version)

// headers: the ones every answer carries (security headers) plus Content-Type / Cache-Control for this file
function sendFile(req, res, file, headers, notFound) {
  fs.stat(file, (e, st) => {
    if (e || !st.isFile()) return notFound();
    const etag = `"${st.size.toString(36)}-${Math.round(st.mtimeMs).toString(36)}"`;
    const h = { ...headers, ETag: etag, Vary: 'Accept-Encoding' };
    if (String(req.headers['if-none-match'] || '').split(/\s*,\s*/).includes(etag)) { res.writeHead(304, h); return res.end(); }
    const gzip = TEXT.test(headers['Content-Type'] || '') && st.size >= MIN_GZIP && /\bgzip\b/.test(String(req.headers['accept-encoding'] || ''));
    const k = kept.get(file);
    if (gzip && k && k.etag === etag) { res.writeHead(200, { ...h, 'Content-Encoding': 'gzip', 'Content-Length': k.gz.length }); return res.end(k.gz); }
    fs.readFile(file, (e2, buf) => {
      if (e2) return notFound();
      if (!gzip) { res.writeHead(200, { ...h, 'Content-Length': buf.length }); return res.end(buf); }
      zlib.gzip(buf, { level: 6 }, (e3, gz) => {
        if (e3) { res.writeHead(200, { ...h, 'Content-Length': buf.length }); return res.end(buf); }
        kept.set(file, { etag, gz });
        res.writeHead(200, { ...h, 'Content-Encoding': 'gzip', 'Content-Length': gz.length });
        res.end(gz);
      });
    });
  });
}

module.exports = { sendFile };
