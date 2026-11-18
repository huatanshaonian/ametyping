// Classic Office 97 / Windows 98 Clippy ("大眼夹") AI Assistant for Windose:
// Animated using original Microsoft Agent Clippy frames (Dimava/codex-clippy WebP sprites) and an authentic
// Office 97 pale-yellow speech balloon (#FFFFCC). Queries structured cross-machine project overviews, directory
// summaries, memories, and verbatim conversation evidence.
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

export function attachClippy(opts = {}) {
  if (!singleton) singleton = createClippyWidget();
  singleton.bindContext(opts);
  singleton.show();
  return singleton;
}

function createClippyWidget() {
  let ctx = {
    project: null,
    projectName: '',
    dirCount: 0,
    changedCount: 0,
    onJumpToDir: null,
    onShowEvidence: null,
    onUpdateOverview: null,
  };
  let balloonOpen = true;
  let hidden = false;
  let busy = false;
  let scope = 'project';
  let history = [];
  let lastAnswer = null;
  let animTimer = null;
  let idleTimer = null;

  const spriteImg = h('img', {
    class: 'clippy-sprite',
    src: SPRITES.rest,
    alt: 'Clippy Office 助手',
    draggable: false,
  });
  const miniHint = h('span', { class: 'clippy-mini-pill', text: '💬 点我提问' });
  const characterBox = h('div', {
    class: 'clippy-char',
    title: '点击展开/收起大眼夹助手气泡（可拖拽移动位置）',
    onclick: () => {
      if (dragMoved) return;
      balloonOpen = !balloonOpen;
      syncVisibility();
      playOnce(balloonOpen ? 'wave' : 'tap', 2200);
    },
  }, spriteImg, miniHint);

  const balloonHeadTitle = h('b', { text: '📎 大眼夹 (Clippy) · 项目助手' });
  const modelBtn = h('button', {
    class: 'clippy-head-btn',
    type: 'button',
    title: '在控制面板 → AI 模型中切换大眼夹使用的模型（默认 gemini-4-hydrogen）',
    text: '⚙️ 模型',
    onclick: async () => {
      const c = await import('./control.js');
      c.open('ai');
    },
  });
  const minBtn = h('button', {
    class: 'clippy-head-btn',
    type: 'button',
    title: '收起对话气泡（保留回形针在角落）',
    text: '＿',
    onclick: () => {
      balloonOpen = false;
      syncVisibility();
    },
  });
  const closeBtn = h('button', {
    class: 'clippy-head-btn',
    type: 'button',
    title: '隐藏大眼夹助手（可随时从项目管理工具栏重新召唤）',
    text: '×',
    onclick: () => hide(),
  });
  const balloonHead = h('div', { class: 'clippy-head' }, balloonHeadTitle, h('span', { style: 'margin-left:auto' }), modelBtn, minBtn, closeBtn);

  const ctxBar = h('div', { class: 'clippy-ctx-bar' });
  const bodyArea = h('div', { class: 'clippy-body' });
  const scopeSelect = h('select', { class: 'field clippy-scope', title: '检索范围' },
    h('option', { value: 'project', text: '当前项目' }),
    h('option', { value: 'all', text: '跨全部项目' })
  );
  scopeSelect.addEventListener('change', () => { scope = scopeSelect.value; });

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

  const inputBar = h('div', { class: 'clippy-input-bar' }, scopeSelect, qInput, askBtn);
  const balloon = h('div', { class: 'clippy-balloon' }, balloonHead, ctxBar, bodyArea, inputBar);
  const root = h('div', { class: 'clippy-root' }, balloon, characterBox);

  // Make Clippy widget draggable via balloonHead or characterBox
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
        const nextRight = Math.max(8, Math.min(window.innerWidth - 160, origRight - dx));
        const nextBottom = Math.max(36, Math.min(window.innerHeight - 140, origBottom - dy));
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
  makeDraggable(balloonHead);
  makeDraggable(characterBox);

  function setSprite(name) {
    const url = SPRITES[name] || SPRITES.rest;
    // Append a cache-key on non-rest animations so animated WebP replays from frame 0
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
    clearInterval(idleTimer);
    idleTimer = setInterval(() => {
      if (hidden || busy || ! document.body.contains(root)) return;
      const pick = IDLE_POOL[Math.floor(Math.random() * IDLE_POOL.length)];
      playOnce(pick, 2500);
    }, 18000);
  }

  function syncVisibility() {
    root.classList.toggle('is-hidden', hidden);
    balloon.classList.toggle('is-collapsed', !balloonOpen);
    miniHint.style.display = balloonOpen ? 'none' : 'inline-block';
  }

  function renderContextBar() {
    const pName = ctx.projectName || '未选项目';
    const pills = [
      h('span', { class: 'clippy-ctx-tag', text: `📂 ${pName}（${ctx.dirCount || 0} 个目录）` }),
    ];
    if (ctx.changedCount > 0) {
      pills.push(h('button', {
        class: 'clippy-update-alert',
        type: 'button',
        title: '检测到有目录新增了对话或尚未生成总结，点击一键增量更新目录总结与项目总览',
        text: `🔔 ${ctx.changedCount} 个目录待更新，点此一键同步`,
        onclick: () => {
          if (typeof ctx.onUpdateOverview === 'function') ctx.onUpdateOverview();
        },
      }));
    }
    ctxBar.replaceChildren(...pills);
  }

  function renderWelcome() {
    const starters = [
      '有没有做过 FDTD 对称面或共形网格加速？结果如何、在哪个目录？',
      '当前项目各求解器或网格方案有哪些已明确的适用边界与限制？',
      '查一下全量 npz 落盘和表面电流存储是在哪台电脑哪个分支做的？',
      '目前各工作树还有哪些未决问题和下一步计划？',
    ];
    bodyArea.replaceChildren(
      h('p', {
        class: 'clippy-greet',
        text: `你好！我是项目小助手大眼夹。我已经读取了「${ctx.projectName || '当前项目'}」的跨机目录总结、课题演进主线、项目记忆与历史对话索引。你想查什么工作进展、代码位置或算例结果？`,
      }),
      h('div', { class: 'clippy-starters' },
        ...starters.map((q) => h('button', {
          class: 'clippy-chip',
          type: 'button',
          text: '💡 ' + q,
          onclick: () => submitQuestion(q),
        }))
      )
    );
  }

  function renderAnswer(res, askedQ) {
    const locs = Array.isArray(res.locations) ? res.locations : [];
    const metrics = Array.isArray(res.key_results) ? res.key_results : [];
    const evs = Array.isArray(res.evidence) ? res.evidence : [];
    const followUps = Array.isArray(res.follow_ups) ? res.follow_ups : [];

    bodyArea.replaceChildren(
      h('div', { class: 'clippy-q-echo' },
        h('span', { text: '🙋 ' + askedQ }),
        h('button', {
          class: 'clippy-back-btn',
          type: 'button',
          text: '返回常用问题',
          onclick: () => renderWelcome(),
        })
      ),
      h('div', { class: 'clippy-headline', text: '💡 ' + (res.headline || '') }),
      h('p', { class: 'clippy-ans-text', text: res.answer || '' }),
      metrics.length ? h('div', { class: 'clippy-sec' },
        h('b', { text: '📊 关键结果与指标：' }),
        h('ul', { class: 'clippy-list' }, ...metrics.map((m) => h('li', { text: m })))
      ) : null,
      locs.length ? h('div', { class: 'clippy-sec' },
        h('b', { text: '📍 所在电脑与目录位置：' }),
        ...locs.map((loc) => h('div', { class: 'clippy-loc-card' },
          h('div', { class: 'clippy-loc-top' },
            h('code', { text: `${loc.machine} : ${loc.path}` }),
            loc.branch ? h('span', { class: 'clippy-branch', text: `[${loc.branch}]` }) : null
          ),
          loc.role ? h('div', { class: 'clippy-loc-role', text: loc.role }) : null,
          loc.files && loc.files.length ? h('div', { class: 'clippy-loc-files', text: '📄 涉及文件/产物：' + loc.files.join('、') }) : null,
          h('div', { class: 'clippy-loc-btns' },
            ctx.onJumpToDir ? h('button', {
              class: 'btn',
              type: 'button',
              text: '🎯 定位到拓扑图节点',
              onclick: () => ctx.onJumpToDir(loc.machine, loc.path),
            }) : null,
            h('button', {
              class: 'btn',
              type: 'button',
              text: '📂 打开目录',
              onclick: () => openExplorer(loc.machine, loc.path),
            })
          )
        ))
      ) : null,
      evs.length ? h('div', { class: 'clippy-sec' },
        h('b', { text: '📜 原文对话依据：' }),
        h('div', { class: 'clippy-ev-list' },
          ...evs.map((ev) => h('div', { class: 'clippy-ev-item' },
            h('span', { class: 'clippy-ev-quote', text: `“${String(ev.quote || '').slice(0, 110)}…”` }),
            ctx.onShowEvidence && ev.event_id ? h('button', {
              class: 'btn',
              type: 'button',
              text: '查看原文',
              onclick: () => ctx.onShowEvidence(ev),
            }) : null
          ))
        )
      ) : null,
      followUps.length ? h('div', { class: 'clippy-sec' },
        h('b', { text: '🔍 继续追问：' }),
        h('div', { class: 'clippy-starters' },
          ...followUps.map((fq) => h('button', {
            class: 'clippy-chip',
            type: 'button',
            text: '▸ ' + fq,
            onclick: () => submitQuestion(fq),
          }))
        )
      ) : null,
      res.model ? h('div', { class: 'clippy-foot-meta', text: `由 ${res.model} 驱动` }) : null
    );
  }

  async function submitQuestion(rawQ) {
    const q = String(rawQ || '').trim();
    if (!q || busy) return;
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
        h('b', { text: `🔍 正在翻阅「${scope === 'all' ? '全部项目' : (ctx.projectName || '当前项目')}」的结构化总结、记忆与对话原文…` }),
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
          h('p', { class: 'aim-bad', text: '⚠️ ' + (r.msg || '查询失败，请稍后重试') }),
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
    } catch (e) {
      clearTimeout(thinkSwitch);
      busy = false;
      askBtn.disabled = false;
      playOnce('alert', 3000);
      bodyArea.replaceChildren(
        h('p', { class: 'aim-bad', text: '⚠️ 网络请求失败' }),
        h('button', { class: 'btn', type: 'button', text: '返回', onclick: () => renderWelcome() })
      );
    }
  }

  function show() {
    if (!document.body.contains(root)) document.body.append(root);
    hidden = false;
    balloonOpen = true;
    syncVisibility();
    renderContextBar();
    if (!lastAnswer) renderWelcome();
    playOnce('greeting', 2600);
    startIdleLoop();
  }

  function hide() {
    playOnce('hide', 900);
    setTimeout(() => {
      hidden = true;
      syncVisibility();
    }, 650);
  }

  function bindContext(next = {}) {
    const prevProject = ctx.project;
    ctx = { ...ctx, ...next };
    renderContextBar();
    if (prevProject !== ctx.project) {
      history = [];
      lastAnswer = null;
      if (!busy) renderWelcome();
      if (ctx.changedCount > 0) playOnce('attention', 2800);
    }
  }

  return {
    root,
    show,
    hide,
    bindContext,
    ask: submitQuestion,
    playOnce,
  };
}
