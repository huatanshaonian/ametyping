// Win98 system sounds for desktop events. Each event can be switched off; the tray speaker sets the volume or mutes;
// the choice is kept per browser, and every Windose page open in it follows a change made in another (the speaker's
// icon too). Browsers refuse to play sound before the first click on a page: a start-up sound refused that way is
// played on the first click / key press instead.
// What the server tells every page at once (a new permission card, a session done, a mail alert) sounds in one page
// of the browser only, not once per page open (sound-once.js).
import { prefs } from './util.js';
import { once } from './sound-once.js';

export const EVENTS = [
  ['startup', '启动（登录后进入桌面）', 'startup.wav', 1],
  ['shutdown', '注销', 'shutdown.wav', 1],
  ['start', '菜单与桌面导航（点开开始菜单 / 图标）', 'start.mp3', 0.5],
  ['perm', '出现新的待确认（权限审批）', 'notify.wav', 1],
  ['ringin', '协作来电（AI 向你提问 / 协同告警与 @点名）', 'ringin.mp3', 1],
  ['ringout', '外呼派单（派生远端节点 / 投递算力作业）', 'ringout.mp3', 0.9],
  ['done', '普通会话完成', 'chimes.wav', 1],
  ['tada', '长任务 / 算力作业 / 协同项目全绿凯旋', 'tada.mp3', 1],
  ['ding', '后台轻量完成（跨机摆渡 / 日报草稿生成）', 'ding.mp3', 0.9],
  ['mail', '邮件提醒（要办的通知、推荐文献）', 'notify.wav', 1],
  ['error', '操作失败', 'chord.wav', 1],
  ['recycle', '删除壁纸', 'recycle.wav', 1],
];
// (the events every page hears of from the server at the same moment)
const SHARED = new Set(['perm', 'ringin', 'done', 'tada', 'ding', 'mail']);
const activeAudio = new Map();
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
  if (!force && SHARED.has(ev)) return once(ev, () => sounded(e, ev));
  return sounded(e, ev);
}
function sounded(e, ev) {
  return new Promise((resolve) => {
    if (ev === 'ringout' && activeAudio.has(ev)) {
      try { const prev = activeAudio.get(ev); prev.pause(); prev.currentTime = 0; } catch {}
      activeAudio.delete(ev);
    }
    const file = e[2].includes('.') ? e[2] : `${e[2]}.wav`;
    const a = new Audio(`/sounds/${file}`);
    a.volume = Math.min(1, Math.max(0, volume() * (e[3] ?? 1)));
    if (ev === 'ringout') activeAudio.set(ev, a);
    const fin = () => { if (activeAudio.get(ev) === a) activeAudio.delete(ev); resolve(); };
    a.onended = fin;
    a.onerror = fin;
    a.play().catch(() => { if (ev === 'startup') pending = ev; fin(); });
  });
}
const later = () => { if (pending) { const ev = pending; pending = null; play(ev); } };
addEventListener('pointerdown', later, true);
addEventListener('keydown', later, true);
// another page of this browser muted, turned the volume, switched a sound on or off: this one shows it too
addEventListener('storage', (e) => { if (e.key && e.key.startsWith('ame.sound.')) for (const fn of listeners) fn(); });
