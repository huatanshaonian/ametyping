window.quotaNotice.onAlert(n => { document.getElementById('heading').textContent = n.title; document.getElementById('body').textContent = n.body; });
document.getElementById('close').addEventListener('click', e => { e.stopPropagation(); window.quotaNotice.close(); });
document.getElementById('box').addEventListener('click', () => window.quotaNotice.open());
