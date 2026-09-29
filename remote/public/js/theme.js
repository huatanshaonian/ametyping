// Colour schemes: Windose (the game's pink, default) and Windows 标准 (css/theme-win98.css). Picked in 显示属性,
// remembered per browser; js/theme-boot.js applies it before the first paint.
import { h, prefs } from './util.js';

export const THEMES = [['windose', 'Windose（粉）'], ['win98', 'Windows 标准']];
// the wallpaper that goes with each scheme, used when switching while the other scheme's default is on
const WALL = { windose: 'pc', win98: 'teal' };

export const current = () => prefs.get('theme', 'windose');

export function set(theme, onWall) {
  const prev = current();
  prefs.set('theme', theme);
  if (theme === 'windose') delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = theme;
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
