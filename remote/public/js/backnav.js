// A phone's back gesture (the swipe from the edge, the back button) goes back inside Windose first: from a
// conversation to the list, from a window to the desktop -- and only then leaves the page. Each "level" the page is
// deep (a window on screen, a conversation open) has an entry in the browser's history; going back takes one entry
// and undoes one level. Going back inside the page by its own buttons (‹ 返回, a window's ×) drops the entry too, so
// the two never get out of step. Touch devices only: with a mouse, the browser's back button stays what it was.
//   level(name, n)   that part of the page is n levels deep now (0 = not at all)
//   step(fn, prio)   how to go back one level: fn() -> true when it did; asked by priority, the innermost first
const on = matchMedia('(pointer: coarse)').matches;
const levels = new Map(), steps = [];
let depth = 0;                      // our entries in the history
let ignore = 0;                     // "popstate"s of our own making (history.go) to pass over
let popping = false;

const total = () => [...levels.values()].reduce((a, b) => a + b, 0);
function sync() {
  if (!on) return;
  const t = total();
  if (t > depth) { for (let i = depth; i < t; i++) history.pushState({ ame: i + 1 }, ''); depth = t; }
  else if (t < depth) {
    const k = depth - t; depth = t;
    if (!popping) { ignore++; history.go(-k); }      // (went back by a button of the page: the entries go as well)
  }
}
export function level(name, n) { levels.set(name, Math.max(0, n | 0)); sync(); }
export function step(fn, prio = 0) { steps.push({ fn, prio }); steps.sort((a, b) => b.prio - a.prio); }
export const enabled = () => on;

addEventListener('popstate', () => {
  if (ignore) { ignore--; return; }
  if (!on || depth <= 0) return;                     // not one of ours (entries left from before a reload: nothing to undo)
  popping = true; depth--;
  try { for (const s of steps) { let did = false; try { did = s.fn(); } catch {} if (did) break; } }
  finally { popping = false; }
  sync();                                            // (nothing could be undone, or more than one level went: in step again)
});
