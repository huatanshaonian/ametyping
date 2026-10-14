// One sound for the browser, not one per Windose page open in it: every page hears of a new permission card from the
// server at the same moment, and each would play it. once(ev, play) plays it unless another page of this browser has
// played the same sound in the last few seconds. The pages take turns through a lock (Web Locks: one at a time),
// and the one that plays writes when, and which page it is, into localStorage, where the next one to hold the lock
// reads it. The same page twice in a row still sounds twice: that is two things happening.
const GAP = 3000;                                  // ms: the same sound from another page this recently is the same news
const me = Math.random().toString(36).slice(2);    // this page
const KEY = (ev) => 'ame.once.' + ev;              // (not ame.sound.*: a change there means the settings changed)

function claim(ev) {
  let last = null;
  try { last = JSON.parse(localStorage.getItem(KEY(ev)) || 'null'); } catch {}
  if (last && last.page !== me && Date.now() - last.t < GAP) return false;
  try { localStorage.setItem(KEY(ev), JSON.stringify({ t: Date.now(), page: me })); } catch {}
  return true;
}

export function once(ev, play) {
  // (no Web Locks -- an old browser: the note in localStorage alone, which two pages may both miss by a moment)
  if (!navigator.locks) return claim(ev) ? play() : Promise.resolve();
  let done;
  const over = new Promise((r) => { done = r; });
  // the lock is held while the sound plays: a page that waited for it reads a note written well before
  navigator.locks.request('ame-sound-' + ev, async () => {
    if (!claim(ev)) return done();
    await play();
    done();
  }).catch(() => done());
  return over;
}
