// Win98 system sounds for desktop events. Each event can be switched off; the tray speaker sets the volume or mutes;
// the choice is kept per browser. Browsers refuse to play sound before the first click on a page: a start-up sound
// refused that way is played on the first click / key press instead.
import { prefs } from './util.js';

export const EVENTS = [
  ['startup', '启动（登录后进入桌面）', 'startup'],
  ['shutdown', '注销', 'shutdown'],
  ['perm', '出现新的待确认', 'notify'],
  ['done', '会话完成', 'chimes'],
  ['mail', '邮件提醒（要办的通知、推荐文献）', 'notify'],
  ['error', '操作失败', 'chord'],
  ['recycle', '删除壁纸', 'recycle'],
];
const listeners = new Set();
let pending = null;

export const muted = () => prefs.get('sound.muted', false);
export const volume = () => Math.min(1, Math.max(0, +prefs.get('sound.volume', 0.8) || 0));
export function setVolume(v) { prefs.set('sound.volume', Math.round(Math.min(1, Math.max(0, v)) * 100) / 100); for (const fn of listeners) fn(); }
export const silent = () => muted() || volume() === 0;
export const enabled = (ev) => !prefs.get('sound.off', []).includes(ev);
export function setMuted(v) { prefs.set('sound.muted', !!v); for (const fn of listeners) fn(); }
export function setEnabled(ev, on) {
  const off = new Set(prefs.get('sound.off', []));
  if (on) off.delete(ev); else off.add(ev);
  prefs.set('sound.off', [...off]);
}
export function onChange(fn) { listeners.add(fn); fn(); return () => listeners.delete(fn); }

// 振动: a new permission card buzzes the phone as well -- whatever the volume (like a phone on silent). Only browsers
// with the Vibration API can (Android; not iPhone), and only while the page is open and has been touched once.
export const canVibrate = typeof navigator.vibrate === 'function' && matchMedia('(pointer: coarse)').matches;   // (desktop Chrome has it, doing nothing)
export const vibrates = () => canVibrate && prefs.get('sound.vibrate', true);
export function setVibrate(v) { prefs.set('sound.vibrate', !!v); for (const fn of listeners) fn(); }
export function buzz(pattern = [180, 90, 180]) { if (vibrates()) { try { navigator.vibrate(pattern); } catch {} } }

// play an event's sound; resolves when it has finished (at once when switched off or refused)
export function play(ev, { force = false } = {}) {
  const e = EVENTS.find((x) => x[0] === ev);
  if (!e || (!force && (muted() || !enabled(ev))) || volume() === 0) return Promise.resolve();
  return new Promise((resolve) => {
    const a = new Audio(`/sounds/${e[2]}.wav`);
    a.volume = volume();
    a.onended = () => resolve();
    a.onerror = () => resolve();
    a.play().catch(() => { if (ev === 'startup') pending = ev; resolve(); });
  });
}
const later = () => { if (pending) { const ev = pending; pending = null; play(ev); } };
addEventListener('pointerdown', later, true);
addEventListener('keydown', later, true);
