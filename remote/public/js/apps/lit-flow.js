// The flowcharts in the cards (```mermaid blocks -- server/literature/flow.js writes them for a deep card's 方法) drawn
// with Mermaid (/vendor/mermaid, one 3.5 MB file: loaded the first time a card has a chart). Strict: no HTML in the
// labels, no links, no scripts. A chart that does not parse stays as its text.
let loading = null, n = 0;

function load() {
  if (window.mermaid) return Promise.resolve(window.mermaid);
  if (!loading) loading = new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = '/vendor/mermaid/mermaid.min.js';
    s.onload = () => {
      window.mermaid.initialize({ startOnLoad: false, securityLevel: 'strict', theme: 'neutral', fontFamily: '"Microsoft YaHei UI", system-ui, sans-serif',
        flowchart: { htmlLabels: false, useMaxWidth: true, curve: 'basis' } });
      resolve(window.mermaid);
    };
    s.onerror = () => { loading = null; reject(new Error('流程图组件没有加载')); };
    document.head.append(s);
  });
  return loading;
}

// codes: the <code class="language-mermaid"> elements of rendered Markdown -> each replaced by its drawing
export async function drawFlows(codes) {
  if (!codes.length) return;
  let m;
  try { m = await load(); } catch { return; }
  for (const code of codes) {
    const pre = code.closest('pre') || code;
    if (!pre.isConnected) continue;
    try {
      const { svg } = await m.render('lit-flow-' + (++n), code.textContent);
      const box = document.createElement('div');
      box.className = 'md-flow'; box.title = '点一下放大 / 还原';
      box.innerHTML = svg;
      box.addEventListener('click', () => box.classList.toggle('big'));
      pre.replaceWith(box);
    } catch { pre.classList.add('md-flow-bad'); document.getElementById('dlit-flow-' + n)?.remove(); }
  }
}
