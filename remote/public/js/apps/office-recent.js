// The documents edited lately (Word / Excel / PowerPoint's 最近的文档): each time office.js opens the editor on a file
// it is put first here. Kept in this browser, the newest 30.
import { prefs } from '../util.js';

const KEY = 'office.recent', MAX = 30;

export function add({ machine, path, name }) {
  const list = prefs.get(KEY, []).filter((x) => !(x.machine === machine && x.path === path));
  list.unshift({ machine, path, name, at: Date.now() });
  prefs.set(KEY, list.slice(0, MAX));
}
export const forget = (machine, path) => prefs.set(KEY, prefs.get(KEY, []).filter((x) => !(x.machine === machine && x.path === path)));
// the ones that fit(name), newest first
export const list = (fit) => prefs.get(KEY, []).filter((x) => x && x.machine && x.path && fit(x.name || ''));
