// 拆分: a paper's PDF in a browser window of its own (/lit-pdf, lit-pdf-page.js), the 深读 window keeping the side
// and the notes -- so each can be made big, on two screens or on two of Windows' desktops (a page cannot reach across
// them by itself). The two talk over a BroadcastChannel (same site, same browser):
//   PDF window -> 深读   here { page, sel } (opened, or answering ping) · page { n } · sel { s } · bye { page } (closed)
//   深读 -> PDF window   ping · goto { n } ([p.N] in an answer, a note's page) · close (收回 PDF, or 深读 closed)
export const splitChannel = (key) => new BroadcastChannel('lit-split:' + key);
export const pdfPageUrl = (key, page) => `/lit-pdf?key=${encodeURIComponent(key)}${page ? '&p=' + page : ''}`;
// one PDF window per paper: opening it again brings that one back
export const pdfWindowName = (key) => 'lit-pdf-' + key;
