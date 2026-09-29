// Step-up: re-enter the authenticator code before acting on a machine (valid 1 hour on the server).
import { $ } from './util.js';

const gate = $('#gate'), form = $('form', gate), input = $('input', gate), msg = $('.gm', gate), okBtn = $('button[type=submit]', gate);
let waiting = null;

// resolves true once a code was accepted, false when cancelled
export function askCode() {
  if (waiting) return waiting.p;
  let resolve; const p = new Promise((r) => { resolve = r; });
  waiting = { p, resolve };
  msg.textContent = ''; input.value = ''; gate.hidden = false; input.focus();
  return p;
}
function close(ok) { gate.hidden = true; const w = waiting; waiting = null; if (w) w.resolve(ok); }

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  okBtn.disabled = true; msg.textContent = '';
  let status = 0, d = {};
  try {
    const r = await fetch('/api/stepup', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code: input.value.replace(/\s/g, '') }) });
    status = r.status; try { d = await r.json(); } catch {}
  } catch {}
  okBtn.disabled = false;
  if (status === 200) return close(true);
  if (status === 401 && d.error === 'unauthorized') { location.href = '/login'; return; }
  msg.textContent = status === 429 ? `尝试次数过多，请 ${Math.ceil((d.retryMs || 0) / 60000)} 分钟后再试` : '验证码不对';
  input.value = ''; input.focus();
});
$('[data-act=cancel]', gate).addEventListener('click', () => close(false));
gate.addEventListener('keydown', (e) => { if (e.key === 'Escape') close(false); });
