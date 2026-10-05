// Colour scheme, shade, night light and size before the first paint (a plain script in <head>, so the page never flashes the other
// look). The choices live in this browser only (js/theme.js writes them; keep the size table in step with it).
try {
  const t = JSON.parse(localStorage.getItem('ame.theme'));
  if (t && t !== 'windose') document.documentElement.dataset.theme = t;
} catch {}
// the shade and the night light as they were last in force (js/shade.js looks again once the page runs)
try {
  const a = JSON.parse(localStorage.getItem('ame.shade.applied'));
  if (a && typeof a.shade === 'string' && /^[a-z]{1,12}$/.test(a.shade)) document.documentElement.dataset.shade = a.shade;
  if (a && a.nl > 0 && a.nl <= 1) { document.documentElement.dataset.nl = '1'; document.documentElement.style.setProperty('--nl', String(+a.nl)); }
} catch {}
try {
  const Z = { xs: 0.9, s: 1, m: 1.15, l: 1.3, xl: 1.5 };
  let s = null; try { s = JSON.parse(localStorage.getItem('ame.scale')); } catch {}
  const z = Z[s] || Z[matchMedia('(pointer: coarse)').matches ? 's' : 'm'];
  if (z !== 1) document.documentElement.style.zoom = z;
} catch {}
