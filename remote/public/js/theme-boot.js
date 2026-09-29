// Colour scheme before the first paint (a plain script in <head>, so the page never flashes the other scheme).
// The choice lives in this browser only (js/theme.js writes it).
try { const t = JSON.parse(localStorage.getItem('ame.theme')); if (t && t !== 'windose') document.documentElement.dataset.theme = t; } catch {}
