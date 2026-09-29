'use strict';
// One request: user + password + code. The server answers every mistake the same way, and so does this page.
const $ = (id) => document.getElementById(id);
const msg = $('msg'), st = $('st');

$('f').addEventListener('submit', async (e) => {
  e.preventDefault();
  const code = $('code').value.replace(/\s/g, '');
  $('ok').disabled = true; msg.textContent = ''; st.textContent = '正在验证…';
  let status = 0, d = {};
  try {
    const r = await fetch('/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ user: $('user').value, password: $('password').value, code }) });
    status = r.status; try { d = await r.json(); } catch {}
  } catch {}
  $('ok').disabled = false;
  if (status === 200 && d.ok) {
    st.textContent = '完成';
    try { sessionStorage.setItem('ame.fresh', '1'); } catch {}          // the desktop plays its start-up sound once
    location.href = '/'; return;
  }
  st.textContent = '就绪';
  if (status === 429) msg.textContent = `尝试次数过多，请 ${Math.ceil((d.retryMs || 0) / 60000)} 分钟后再试。`;
  else if (!status) msg.textContent = '无法连接，请稍后再试。';
  else msg.textContent = '登录失败。';
  $('code').value = ''; $('code').focus();
});
$('f').addEventListener('reset', () => { msg.textContent = ''; st.textContent = '就绪'; setTimeout(() => $('user').focus()); });
$('user').focus();
