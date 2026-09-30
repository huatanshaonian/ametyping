// The tray speaker: its icon shows whether sound is on; a click opens the old Windows "音量" popup -- a vertical
// slider in a sunken groove with tick marks, and a 静音 box. Letting go of the slider plays a short sound at the new
// level, as Windows 98 did.
import { $, h, icon, zoom } from './util.js';
import * as sound from './sound.js';

const btn = $('#soundbtn');
const thumb = h('div', { class: 'vthumb', tabindex: 0, role: 'slider', 'aria-label': '音量', 'aria-valuemin': 0, 'aria-valuemax': 100 });
const track = h('div', { class: 'vtrack' }, h('div', { class: 'vticks' }), h('div', { class: 'vgroove' }), thumb);
const mute = h('input', { type: 'checkbox' });
// 振动 only where the phone can (sound.js canVibrate)
const vib = h('input', { type: 'checkbox' });
const pop = h('div', { id: 'volpop', hidden: true },
  h('div', { class: 'vt', text: '音量' }), track, h('label', { class: 'vmute' }, mute, h('span', { text: '静音' })),
  sound.canVibrate ? h('label', { class: 'vmute', title: '有新的待确认时手机振动（和音量无关）' }, vib, h('span', { text: '振动' })) : null);
document.body.append(pop);

const TOP = 6, RANGE = 96;                 // px of the track the thumb's centre can travel (top = loudest)
function show() {
  const v = sound.volume();
  thumb.style.top = TOP + Math.round((1 - v) * RANGE) + 'px';
  thumb.setAttribute('aria-valuenow', Math.round(v * 100));
  mute.checked = sound.muted();
  vib.checked = sound.vibrates();
  btn.firstElementChild.src = icon(sound.silent() ? 'loudspeaker_muted' : 'loudspeaker_rays', true);
  btn.title = sound.silent() ? '音量：静音' : `音量：${Math.round(v * 100)}%`;
}
sound.onChange(show);

function setFrom(clientY) {
  const r = track.getBoundingClientRect();
  sound.setVolume(1 - ((clientY - r.top) / zoom() - TOP) / RANGE);     // the rect is in screen px, TOP / RANGE in page px
}
let dragging = false;
track.addEventListener('pointerdown', (e) => { dragging = true; track.setPointerCapture(e.pointerId); setFrom(e.clientY); e.preventDefault(); });
track.addEventListener('pointermove', (e) => { if (dragging) setFrom(e.clientY); });
const end = () => { if (!dragging) return; dragging = false; if (!sound.muted()) sound.play('perm', { force: true }); };   // a sample at the new level
track.addEventListener('pointerup', end);
track.addEventListener('pointercancel', end);
thumb.addEventListener('keydown', (e) => {
  const step = { ArrowUp: 0.05, ArrowRight: 0.05, ArrowDown: -0.05, ArrowLeft: -0.05, PageUp: 0.2, PageDown: -0.2 }[e.key];
  if (step) { e.preventDefault(); sound.setVolume(sound.volume() + step); }
});
mute.addEventListener('change', () => sound.setMuted(mute.checked));
vib.addEventListener('change', () => { sound.setVibrate(vib.checked); sound.buzz([120]); });      // a short sample when turned on

btn.addEventListener('click', (e) => { e.stopPropagation(); pop.hidden = !pop.hidden; if (!pop.hidden) thumb.focus(); });
document.addEventListener('pointerdown', (e) => { if (!pop.hidden && !pop.contains(e.target) && !btn.contains(e.target)) pop.hidden = true; });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') pop.hidden = true; });
