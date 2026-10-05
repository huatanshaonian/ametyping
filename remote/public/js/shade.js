// 色调 and 夜灯 (css/theme-shades.css), picked in 显示属性 and remembered per browser:
//   色调      another set of colours for the look in use -- Windose: 深夜, 梅子; Windows 标准: 沙漠, 豆沙绿 -- one for the
//             day and, when 自动切换 is on, another for the night
//   自动切换   关闭 (the default) / 按日出日落 (worked out from a place: a city or coordinates, js/sun.js) / 固定时间
//   夜灯      the whole page warmed and dimmed: 关闭 / 一直开 / 只在夜间 (the night of 自动切换), with its strength
// What is in force is put on <html> (data-shade, data-nl + --nl) and kept as "shade.applied" for js/theme-boot.js,
// which puts it back before the first paint of the next visit; it is looked at again every minute and whenever the
// page comes back on screen.
import { prefs } from './util.js';
import { isNightAt, sunTimes, CITIES } from './sun.js';

export const SHADES = {
  windose: [['', '浅色（原样）'], ['night', '深夜'], ['plum', '梅子']],
  win98: [['', '标准（白底）'], ['desert', '沙漠'], ['green', '豆沙绿']],
};
const NIGHT_DEFAULT = { windose: 'night', win98: 'desert' };
export const AUTOS = [['off', '关闭'], ['sun', '按日出日落'], ['clock', '固定时间']];
export const LIGHTS = [['off', '关闭'], ['on', '一直开'], ['night', '只在夜间']];

const look = () => (prefs.get('theme', 'windose') === 'win98' ? 'win98' : 'windose');
const known = (l, v) => (SHADES[l].some((s) => s[0] === v) ? v : null);
export const get = () => {
  const l = look(), day = prefs.get('shade.day', {}), night = prefs.get('shade.night', {});
  const nl = prefs.get('nl', {}), clock = prefs.get('shade.clock', {}), place = prefs.get('shade.place', null);
  return { look: l, day: known(l, day[l]) ?? '', night: known(l, night[l]) ?? NIGHT_DEFAULT[l],
    auto: AUTOS.some((a) => a[0] === prefs.get('shade.auto', 'off')) ? prefs.get('shade.auto', 'off') : 'off',
    clock: { from: /^\d\d:\d\d$/.test(clock.from) ? clock.from : '19:00', to: /^\d\d:\d\d$/.test(clock.to) ? clock.to : '07:00' },
    place: place && isFinite(place.lat) && isFinite(place.lon) ? { lat: +place.lat, lon: +place.lon, name: String(place.name || '') } : { lat: CITIES[0][1], lon: CITIES[0][2], name: CITIES[0][0] },
    light: LIGHTS.some((x) => x[0] === nl.mode) ? nl.mode : 'off', level: nl.level >= 0.1 && nl.level <= 1 ? +nl.level : 0.5 };
};

const mins = (hhmm) => +hhmm.slice(0, 2) * 60 + +hhmm.slice(3);
// is it night now, the way 自动切换 tells it (never when it is off)
export function isNight(s = get(), now = Date.now()) {
  if (s.auto === 'sun') return isNightAt(now, s.place.lat, s.place.lon);
  if (s.auto !== 'clock') return false;
  const d = new Date(now), m = d.getHours() * 60 + d.getMinutes(), a = mins(s.clock.from), b = mins(s.clock.to);
  return a === b ? false : a < b ? m >= a && m < b : m >= a || m < b;       // (19:00 -> 07:00 goes over midnight)
}
// today's sunrise and sunset at the chosen place, as "06:14 / 17:50" (for the settings window)
export function sunText(s = get()) {
  const t = sunTimes(Date.now(), s.place.lat, s.place.lon);
  if (t.polar) return t.polar === 'night' ? '今天太阳不升起' : '今天太阳不落下';
  const f = (ms) => { const d = new Date(ms); return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0'); };
  return `今天日出 ${f(t.rise)}，日落 ${f(t.set)}`;
}

const listeners = new Set();
export function onChange(fn) { listeners.add(fn); return () => listeners.delete(fn); }

// put what is in force on the page; -> { shade, nl (0 = off), night }
export function apply() {
  const s = get(), night = isNight(s), el = document.documentElement;
  const shade = night ? s.night : s.day;
  const nl = s.light === 'on' || (s.light === 'night' && night) ? s.level : 0;
  if (shade) el.dataset.shade = shade; else delete el.dataset.shade;
  if (nl) { el.dataset.nl = '1'; el.style.setProperty('--nl', String(nl)); } else { delete el.dataset.nl; el.style.removeProperty('--nl'); }
  const now = { shade, nl, night };
  const was = prefs.get('shade.applied', null);
  if (!was || was.shade !== shade || was.nl !== nl) { prefs.set('shade.applied', { shade, nl }); for (const fn of listeners) fn(now); }
  return now;
}

// one of: { day, night } (for the look in use), { auto }, { clock: { from, to } }, { place: { lat, lon, name } }, { light }, { level }
export function set(o) {
  const l = look();
  if (o.day != null && known(l, o.day) != null) prefs.set('shade.day', { ...prefs.get('shade.day', {}), [l]: o.day });
  if (o.night != null && known(l, o.night) != null) prefs.set('shade.night', { ...prefs.get('shade.night', {}), [l]: o.night });
  if (o.auto && AUTOS.some((a) => a[0] === o.auto)) prefs.set('shade.auto', o.auto);
  if (o.clock) prefs.set('shade.clock', { ...get().clock, ...o.clock });
  if (o.place && isFinite(o.place.lat) && isFinite(o.place.lon) && Math.abs(o.place.lat) <= 90 && Math.abs(o.place.lon) <= 180) prefs.set('shade.place', { lat: +o.place.lat, lon: +o.place.lon, name: String(o.place.name || '').slice(0, 20) });
  if (o.light && LIGHTS.some((x) => x[0] === o.light)) prefs.set('nl', { ...prefs.get('nl', {}), mode: o.light });
  if (o.level != null) prefs.set('nl', { ...prefs.get('nl', {}), level: Math.min(1, Math.max(0.1, +o.level || 0.5)) });
  return apply();
}

// main.js: once at the start, then every minute and when the page is back on screen (dusk comes while it is open)
export function start() {
  apply();
  setInterval(apply, 60000);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) apply(); });
}
