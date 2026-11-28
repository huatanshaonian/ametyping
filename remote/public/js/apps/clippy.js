// Desktop-resident Classic Office 97 Clippy AI Assistant for Windose:
// Sits quietly in the desktop corner with no label; double-clicking opens the classic #FFFFCC speech balloon.
import { h } from '../util.js';
import { post } from '../net.js';
import { open as openExplorer } from './explorer.js';

const SPRITES = {
  rest: '/icons/clippy-rest.webp',
  show: '/icons/clippy-show.webp',
  hide: '/icons/clippy-hide.webp',
  wave: '/icons/clippy-wave.webp',
  greeting: '/icons/clippy-greeting.webp',
  tap: '/icons/clippy-tap.webp',
  eyebrow: '/icons/clippy-eyebrow.webp',
  scratch: '/icons/clippy-scratch.webp',
  attention: '/icons/clippy-attention.webp',
  searching: '/icons/clippy-searching.webp',
  thinking: '/icons/clippy-thinking.webp',
  processing: '/icons/clippy-processing.webp',
  writing: '/icons/clippy-writing.webp',
  explain: '/icons/clippy-explain.webp',
  congratulate: '/icons/clippy-congratulate.webp',
  alert: '/icons/clippy-alert.webp',
};

const IDLE_POOL = ['tap', 'eyebrow', 'scratch', 'wave'];

let singleton = null;

export function initDesktopClippy() {
  if (!singleton) singleton = createClippyWidget();
  singleton.mountDesktop();
  return singleton;
}

export function attachClippy(opts = {}) {
  if (!singleton) singleton = createClippyWidget();
  singleton.mountDesktop();
  singleton.bindContext(opts);
  return singleton;
}

function createClippyWidget() {
  let ctx = {
    project: null,
    projectName: '',
    projects: [],
    dirCount: 0,
    changedCount: 0,
    onJumpToDir: null,
    onShowEvidence: null,
    onUpdateOverview: null,
  };
  let balloonOpen = false; // Speech balloon is closed by default; only opens on double-click
  let busy = false;
  let scope = 'project';
  let history = [];
  let lastAnswer = null;
  let animTimer = null;
  let idleTimer = null;

  const spriteImg = h('img', {
    class: 'clippy-sprite',
    src: SPRITES.rest,
    alt: '',
    draggable: false,
  });

  // Pure character sprite: single-click plays a subtle animation; double-click toggles the speech balloon
  const characterBox = h('div', {
    class: 'clippy-char',
    title: '双击打开/关闭对话气泡（按住可拖拽移动）',
    onclick: () => {
      if (dragMoved) return;
      if (!busy) playOnce('tap', 1800);
    },
    ondblclick: async (e) => {
      e.preventDefault();
      e.stopPropagation();
      balloonOpen = !balloonOpen;
      syncVisibility();
      if (balloonOpen) {
        playOnce('wave', 2200);
        await ensureProjectsLoaded();
        if (!lastAnswer && !busy) renderWelcome();
        setTimeout(() => qInput.focus(), 60);
      }
    },
  }, spriteImg);

  const projSelect = h('select', { class: 'field clippy-proj-sel', title: '选择项目' });
  projSelect.addEventListener('change', () => {
    const picked = ctx.projects.find((p) => p.id === projSelect.value);
    if (picked) {
      ctx.project = picked.id;
      ctx.projectName = picked.name;
      ctx.dirCount = (picked.directories || []).length;
      history = [];
      lastAnswer = null;
      if (!busy) renderWelcome();
    }
  });

  const scopeSelect = h('select', { class: 'field clippy-scope', title: '检索范围' },
    h('option', { value: 'project', text: '当前项目' }),
    h('option', { value: 'all', text: '跨全部项目' })
  );
  scopeSelect.addEventListener('change', () => {
    scope = scopeSelect.value;
    projSelect.style.display = scope === 'all' ? 'none' : '';
  });

  const modelBtn = h('button', {
    class: 'clippy-head-btn',
    type: 'button',
    title: '打开 AI 与额度中心 → 模型设置',
    text: '⚙',
    onclick: () => {
      location.hash = '#ai?tab=models&sec=clippy';
    },
  });
  const closeBtn = h('button', {
    class: 'clippy-head-btn',
    type: 'button',
    title: '收起气泡（双击回形针再次打开）',
    text: '×',
    onclick: () => {
      balloonOpen = false;
      syncVisibility();
    },
  });

  // Compact top bar inside balloon without any title/name text
  const topBar = h('div', { class: 'clippy-top-bar' }, scopeSelect, projSelect, h('span', { style: 'margin-left:auto' }), modelBtn, closeBtn);
  const bodyArea = h('div', { class: 'clippy-body' });

  const qInput = h('input', {
    class: 'field clippy-input',
    type: 'text',
    placeholder: '问我：有没有做过 xxx？结果如何？在哪个目录？',
  });
  const askBtn = h('button', {
    class: 'btn go clippy-send',
    type: 'button',
    text: '提问',
    onclick: () => submitQuestion(qInput.value),
  });
  qInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      submitQuestion(qInput.value);
    }
  });

  const inputBar = h('div', { class: 'clippy-input-bar' }, qInput, askBtn);
  const balloon = h('div', { class: 'clippy-balloon is-collapsed' }, topBar, bodyArea, inputBar);
  const root = h('div', { class: 'clippy-root' }, balloon, characterBox);

  // Draggable via characterBox or topBar
  let dragMoved = false;
  function makeDraggable(handle) {
    handle.addEventListener('pointerdown', (e) => {
      if (e.target.closest('button, input, select, a')) return;
      dragMoved = false;
      const rect = root.getBoundingClientRect();
      const startX = e.clientX, startY = e.clientY;
      const origRight = window.innerWidth - rect.right;
      const origBottom = window.innerHeight - rect.bottom;
      const onMove = (ev) => {
        const dx = ev.clientX - startX, dy = ev.clientY - startY;
        if (Math.abs(dx) > 4 || Math.abs(dy) > 4) dragMoved = true;
        if (!dragMoved) return;
        const nextRight = Math.max(8, Math.min(window.innerWidth - 130, origRight - dx));
        const nextBottom = Math.max(34, Math.min(window.innerHeight - 110, origBottom - dy));
        root.style.right = nextRight + 'px';
        root.style.bottom = nextBottom + 'px';
      };
      const onUp = () => {
        window.removeEventListener('pointermove', onMove);
        window.removeEventListener('pointerup', onUp);
        setTimeout(() => { dragMoved = false; }, 50);
      };
      window.addEventListener('pointermove', onMove);
      window.addEventListener('pointerup', onUp);
    });
  }
  makeDraggable(topBar);
  makeDraggable(characterBox);

  function setSprite(name) {
    const url = SPRITES[name] || SPRITES.rest;
    spriteImg.src = name === 'rest' ? url : `${url}?t=${Date.now() % 100000}`;
  }

  function playOnce(name, durationMs = 2400) {
    clearTimeout(animTimer);
    setSprite(name);
    animTimer = setTimeout(() => {
      if (!busy) setSprite('rest');
    }, durationMs);
  }

  function startIdleLoop() {
    if (idleTimer) return;
    idleTimer = setInterval(() => {
      if (busy || !document.body.contains(root)) return;
      const pick = IDLE_POOL[Math.floor(Math.random() * IDLE_POOL.length)];
      playOnce(pick, 2500);
    }, 20000);
  }

  function syncVisibility() {
    balloon.classList.toggle('is-collapsed', !balloonOpen);
  }

  function syncProjectSelect() {
    if (!ctx.projects.length) return;
    projSelect.replaceChildren(
      ...ctx.projects.map((p) => h('option', {
        value: p.id,
        text: `${p.name} (${(p.directories || []).length})`,
      }))
    );
    if (ctx.project) projSelect.value = ctx.project;
  }

  async function ensureProjectsLoaded() {
    if (ctx.projects.length && ctx.project) {
      syncProjectSelect();
      return;
    }
    try {
      const r = await (await fetch('/api/research/review/projects')).json();
      if (r && r.ok && Array.isArray(r.items) && r.items.length) {
        ctx.projects = r.items;
        if (!ctx.project) {
          const def = r.items.find((x) => /cem_po/i.test(x.name)) || r.items[0];
          ctx.project = def.id;
          ctx.projectName = def.name;
          ctx.dirCount = (def.directories || []).length;
        }
        syncProjectSelect();
      }
    } catch {}
  }

  async function jumpToDir(machine, dirPath) {
    if (typeof ctx.onJumpToDir === 'function') {
      ctx.onJumpToDir(machine, dirPath);
      return;
    }
    try {
      const pm = await import('./projects.js');
      pm.open(ctx.project);
      setTimeout(() => {
        if (typeof ctx.onJumpToDir === 'function') ctx.onJumpToDir(machine, dirPath);
      }, 600);
    } catch {}
  }

  async function showEvidence(ev) {
    if (typeof ctx.onShowEvidence === 'function') {
      ctx.onShowEvidence(ev);
      return;
    }
    try {
      const pId = ev.project || ctx.project;
      const r = await (await fetch('/api/research/evidence?project=' + encodeURIComponent(pId) + '&id=' + encodeURIComponent(ev.event_id))).json();
      if (!r || !r.ok) return;
      const e = r.item;
      const dlg = h('dialog', { class: 'pr-evidence' },
        h('b', { text: e.machine + ' · ' + e.cwd }),
        h('p', { text: '会话 ' + e.session + ' · 记录 ' + e.line }),
        h('blockquote', { text: ev.quote }),
        h('pre', { text: e.text }),
        h('div', { class: 'pr-toolbar', style: 'margin-top:8px;justify-content:flex-end' },
          e.machine && e.session ? h('button', {
            class: 'btn go',
            type: 'button',
            text: '💬 在糖糖看板打开该会话',
            onclick: () => {
              dlg.close();
              import('./dashboard.js').then((m) => m.openSession(e.machine, e.session)).catch(() => {});
            },
          }) : null,
          h('button', { class: 'btn', type: 'button', text: '关闭', onclick: () => dlg.close() })
        )
      );
      dlg.addEventListener('close', () => dlg.remove());
      document.body.append(dlg);
      dlg.showModal();
    } catch {}
  }

  function renderWelcome() {
    const starters = [
      '有没有做过 FDTD 对称面或共形网格加速？结果如何、在哪个目录？',
      '当前项目各求解器或网格方案有哪些已明确的适用边界与限制？',
      '查一下全量 npz 落盘和表面电流存储是在哪台电脑哪个分支做的？',
      '目前各工作树还有哪些未决问题和下一步计划？',
    ];
    bodyArea.replaceChildren(...[
      ctx.changedCount > 0 && typeof ctx.onUpdateOverview === 'function' ? h('button', {
        class: 'clippy-update-alert',
        type: 'button',
        text: `检测到 ${ctx.changedCount} 个目录有新对话，点此一键同步项目总览`,
        onclick: () => ctx.onUpdateOverview(),
      }) : null,
      h('p', {
        class: 'clippy-greet',
        text: `已连接「${ctx.projectName || '当前项目'}」的结构化目录总结、课题主线、项目记忆与对话原文。你想查什么功能、结果或目录位置？`,
      }),
      h('div', { class: 'clippy-starters' },
        ...starters.map((q) => h('button', {
          class: 'clippy-chip',
          type: 'button',
          text: '▸ ' + q,
          onclick: () => submitQuestion(q),
        }))
      ),
    ].filter(Boolean));
  }

  function renderAnswer(res, askedQ) {
    const locs = Array.isArray(res.locations) ? res.locations : [];
    const metrics = Array.isArray(res.key_results) ? res.key_results : [];
    const evs = Array.isArray(res.evidence) ? res.evidence : [];
    const followUps = Array.isArray(res.follow_ups) ? res.follow_ups : [];

    bodyArea.replaceChildren(...[
      h('div', { class: 'clippy-q-echo' },
        h('span', { text: '问：' + askedQ }),
        h('button', {
          class: 'clippy-back-btn',
          type: 'button',
          text: '返回',
          onclick: () => renderWelcome(),
        })
      ),
      h('div', { class: 'clippy-headline', text: res.headline || '' }),
      h('p', { class: 'clippy-ans-text', text: res.answer || '' }),
      metrics.length ? h('div', { class: 'clippy-sec' },
        h('b', { text: '关键结果与指标：' }),
        h('ul', { class: 'clippy-list' }, ...metrics.map((m) => h('li', { text: m })))
      ) : null,
      locs.length ? h('div', { class: 'clippy-sec' },
        h('b', { text: '所在电脑与目录位置：' }),
        ...locs.map((loc) => h('div', { class: 'clippy-loc-card' },
          h('div', { class: 'clippy-loc-top' },
            h('code', { text: `${loc.machine} : ${loc.path}` }),
            loc.branch ? h('span', { class: 'clippy-branch', text: `[${loc.branch}]` }) : null
          ),
          loc.role ? h('div', { class: 'clippy-loc-role', text: loc.role }) : null,
          loc.files && loc.files.length ? h('div', { class: 'clippy-loc-files', text: '涉及文件/产物：' + loc.files.join('、') }) : null,
          h('div', { class: 'clippy-loc-btns' },
            h('button', {
              class: 'btn',
              type: 'button',
              text: '定位到拓扑图节点',
              onclick: () => jumpToDir(loc.machine, loc.path),
            }),
            h('button', {
              class: 'btn',
              type: 'button',
              text: '打开目录',
              onclick: () => openExplorer(loc.machine, loc.path),
            })
          )
        ))
      ) : null,
      evs.length ? h('div', { class: 'clippy-sec' },
        h('b', { text: '原文对话依据：' }),
        h('div', { class: 'clippy-ev-list' },
          ...evs.map((ev) => h('div', { class: 'clippy-ev-item' },
            h('span', { class: 'clippy-ev-quote', text: `“${String(ev.quote || '').slice(0, 110)}…”` }),
            ev.event_id ? h('button', {
              class: 'btn',
              type: 'button',
              text: '查看原文',
              onclick: () => showEvidence(ev),
            }) : null
          ))
        )
      ) : null,
      followUps.length ? h('div', { class: 'clippy-sec' },
        h('b', { text: '继续追问：' }),
        h('div', { class: 'clippy-starters' },
          ...followUps.map((fq) => h('button', {
            class: 'clippy-chip',
            type: 'button',
            text: '▸ ' + fq,
            onclick: () => submitQuestion(fq),
          }))
        )
      ) : null,
    ].filter(Boolean));
  }

  async function submitQuestion(rawQ) {
    const q = String(rawQ || '').trim();
    if (!q || busy) return;
    await ensureProjectsLoaded();
    if (!ctx.project && scope !== 'all') return;
    busy = true;
    askBtn.disabled = true;
    qInput.value = '';
    balloonOpen = true;
    syncVisibility();
    clearTimeout(animTimer);
    setSprite('searching');
    const thinkSwitch = setTimeout(() => { if (busy) setSprite('thinking'); }, 3200);
    bodyArea.replaceChildren(
      h('div', { class: 'clippy-loading' },
        h('b', { text: `正在检索「${scope === 'all' ? '全部项目' : (ctx.projectName || '当前项目')}」的结构化总结、记忆与对话原文…` }),
        h('p', { class: 'ghint', text: '问题：' + q })
      )
    );
    try {
      const r = await post('/api/research/assistant', {
        project: ctx.project,
        question: q,
        scope,
        history,
      });
      clearTimeout(thinkSwitch);
      busy = false;
      askBtn.disabled = false;
      if (!r.ok || !r.item) {
        playOnce('alert', 3000);
        bodyArea.replaceChildren(
          h('p', { class: 'aim-bad', text: r.msg || '查询失败，请稍后重试' }),
          h('button', { class: 'btn', type: 'button', text: '返回', onclick: () => (lastAnswer ? renderAnswer(lastAnswer.res, lastAnswer.q) : renderWelcome()) })
        );
        return;
      }
      const item = r.item;
      history.push({ q, a: `${item.headline} ${item.answer}` });
      if (history.length > 6) history = history.slice(-6);
      lastAnswer = { q, res: item };
      renderAnswer(item, q);
      playOnce(item.mood || 'explain', 3500);
    } catch {
      clearTimeout(thinkSwitch);
      busy = false;
      askBtn.disabled = false;
      playOnce('alert', 3000);
      bodyArea.replaceChildren(
        h('p', { class: 'aim-bad', text: '网络请求失败' }),
        h('button', { class: 'btn', type: 'button', text: '返回', onclick: () => renderWelcome() })
      );
    }
  }

  function mountDesktop() {
    if (!document.body.contains(root)) {
      document.body.append(root);
      syncVisibility();
      startIdleLoop();
    }
  }

  function bindContext(next = {}) {
    const prevProject = ctx.project;
    ctx = { ...ctx, ...next };
    syncProjectSelect();
    if (prevProject !== ctx.project) {
      history = [];
      lastAnswer = null;
      if (balloonOpen && !busy) renderWelcome();
    }
  }

  return {
    root,
    mountDesktop,
    bindContext,
    ask: submitQuestion,
    playOnce,
  };
}
