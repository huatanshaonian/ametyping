// Colour scheme and size before the first paint (a plain script in <head>, so the page never flashes the other
// look). The choices live in this browser only (js/theme.js writes them; keep the size table in step with it).
try {
  const t = JSON.parse(localStorage.getItem('ame.theme'));
  if (t && t !== 'windose') document.documentElement.dataset.theme = t;
} catch {}
try {
  const Z = { xs: 0.9, s: 1, m: 1.15, l: 1.3, xl: 1.5 };
  let s = null; try { s = JSON.parse(localStorage.getItem('ame.scale')); } catch {}
  const z = Z[s] || Z[matchMedia('(pointer: coarse)').matches ? 's' : 'm'];
  if (z !== 1) document.documentElement.style.zoom = z;
} catch {}
