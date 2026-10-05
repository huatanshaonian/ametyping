// Appearance, picked in 显示属性 and remembered per browser (js/theme-boot.js applies both before the first paint):
//   colour scheme  Windose（粉, default) or Windows 标准 (css/theme-win98.css); each has shades of its own (js/shade.js)
//   size           five steps of zoom over the whole page; 小 is the original size, 中 the default (小 on phones)
import { h, prefs } from './util.js';
import * as shade from './shade.js';

export const THEMES = [['windose', 'Windose（粉）'], ['win98', 'Windows 标准']];
// the wallpaper that goes with each scheme, used when switching while the other scheme's default is on
const WALL = { windose: 'pc', win98: 'teal' };

export const current = () => prefs.get('theme', 'windose');

export function set(theme, onWall) {
  const prev = current();
  prefs.set('theme', theme);
  if (theme === 'windose') delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = theme;
  shade.apply();                               // each look has its own shades (js/shade.js)
  const wall = prefs.get('wall', 'pc');
  if (wall === WALL[prev] || (theme === 'win98' && wall === 'plain')) { prefs.set('wall', WALL[theme]); onWall && onWall(); }
}

// the <select> for the settings window; onWall runs when the wallpaper changed along with the scheme
export function picker(onWall) {
  const sel = h('select', { class: 'field', title: '配色方案' },
    ...THEMES.map(([v, l]) => h('option', { value: v, text: l, selected: current() === v })));
  sel.addEventListener('change', () => set(sel.value, onWall));
  return sel;
}

// ---- size ----
export const SCALES = [['xs', '特小', 0.9], ['s', '小', 1], ['m', '中', 1.15], ['l', '大', 1.3], ['xl', '特大', 1.5]];
const defaultScale = () => (matchMedia('(pointer: coarse)').matches ? 's' : 'm');
export const currentScale = () => prefs.get('scale', defaultScale());

export function setScale(key) {
  const s = SCALES.find((x) => x[0] === key) || SCALES[2];
  prefs.set('scale', s[0]);
  document.documentElement.style.zoom = s[2] === 1 ? '' : String(s[2]);
  dispatchEvent(new Event('resize'));          // windows re-fit the (now smaller or larger) desktop
}

export function scalePicker() {
  const sel = h('select', { class: 'field', title: '界面大小（字体、窗口、图标一起缩放）' },
    ...SCALES.map(([v, l]) => h('option', { value: v, text: l, selected: currentScale() === v })));
  sel.addEventListener('change', () => setScale(sel.value));
  return sel;
}
