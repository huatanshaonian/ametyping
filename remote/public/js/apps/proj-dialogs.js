// Modal dialogs for AmeMesh Projects (watchdog, triggers, spawn, bind, link, send, workspaces, transfers).
import { h } from '../util.js';
import * as net from '../net.js';
import * as mesh from '../mesh.js';
import * as catalog from '../fs-catalog.js';

export async function openWatchdogConfigDialog({ say }) {
  say('正在读取看门狗配置…');
  const res = await mesh.getConfig();
  const cfg = (res && res.ok && res.config) ? res.config : {};
  const val = (k, def) => (cfg[k] != null ? cfg[k] : def);

  const f = {
    idleNudgeMin: h('input', { class: 'field', type: 'number', min: '1', step: '1', value: String(val('idleNudgeMin', 3)) }),
    idleAlertMin: h('input', { class: 'field', type: 'number', min: '1', step: '1', value: String(val('idleAlertMin', 10)) }),
    askingAlertMin: h('input', { class: 'field', type: 'number', min: '1', step: '1', value: String(val('askingAlertMin', 10)) }),
    silentAlertMin: h('input', { class: 'field', type: 'number', min: '1', step: '1', value: String(val('silentAlertMin', 60)) }),
    loopWindowMin: h('input', { class: 'field', type: 'number', min: '1', step: '1', value: String(val('loopWindowMin', 10)) }),
    loopCount: h('input', { class: 'field', type: 'number', min: '2', step: '1', value: String(val('loopCount', 5)) }),
    loopNudge: h('input', { type: 'checkbox', checked: val('loopNudge', true) !== false }),
    autoRestart: h('input', { type: 'checkbox', checked: val('autoRestart', true) !== false }),
    restartWindowMin: h('input', { class: 'field', type: 'number', min: '1', step: '1', value: String(val('restartWindowMin', 30)) }),
    offlineAlertMin: h('input', { class: 'field', type: 'number', min: '1', step: '1', value: String(val('offlineAlertMin', 2)) }),
    mentionTimeoutMin: h('input', { class: 'field', type: 'number', min: '1', step: '1', value: String(val('mentionTimeoutMin', 10)) }),
    swarmStallMin: h('input', { class: 'field', type: 'number', min: '1', step: '1', value: String(val('swarmStallMin', 5)) }),
    folderPollSec: h('input', { class: 'field', type: 'number', min: '5', step: '5', value: String(val('folderPollSec', 30)) }),
    triggerMaxPerHour: h('input', { class: 'field', type: 'number', min: '1', step: '1', value: String(val('triggerMaxPerHour', 6)) }),
  };

  const done = () => wrap.remove();
  const form = h('form', { class: 'dlgbox xnote-dlg pm-wd-dlg', autocomplete: 'off' },
    h('div', { class: 'dlgt' }, h('span', { text: '看门狗与触发器参数配置 (W1~W8)' }), h('button', { class: 'dlgx', type: 'button', text: '×', onclick: done })),
    h('div', { class: 'dlgb' },
      h('div', { class: 'pm-wd-sec', text: '基础看门狗阈值 (W1~W6)' }),
      h('div', { class: 'pm-wd-grid' },
        h('label', { text: 'W1 空闲提醒汇报超时(分钟)：' }), f.idleNudgeMin,
        h('label', { text: 'W1 空闲升级告警追加(分钟)：' }), f.idleAlertMin,
        h('label', { text: 'W2 权限确认卡死超时(分钟)：' }), f.askingAlertMin,
        h('label', { text: 'W3 连续工作无汇报超时(分钟)：' }), f.silentAlertMin,
        h('label', { text: 'W4 错误循环检测窗口(分钟)：' }), f.loopWindowMin,
        h('label', { text: 'W4 同错重复触发次数阈值：' }), f.loopCount,
        h('label', { class: 'pm-wd-chk' }, f.loopNudge, 'W4 检测到错误死循环时自动发消息提醒停止盲试'),
        h('label', { class: 'pm-wd-chk' }, f.autoRestart, 'W5 会话意外退出时自动唤醒恢复 (窗口期内最多1次)'),
        h('label', { text: 'W5 重启次数统计窗口(分钟)：' }), f.restartWindowMin,
        h('label', { text: 'W6 机器掉线告警超时(分钟)：' }), f.offlineAlertMin
      ),
      h('div', { class: 'pm-wd-sec', text: 'Swarm 协同看门狗阈值 (W7~W8)' }),
      h('div', { class: 'pm-wd-grid' },
        h('label', { text: 'W7 点名未回帖超时(分钟)：' }), f.mentionTimeoutMin,
        h('label', { text: 'W8 全组停滞超时(分钟)：' }), f.swarmStallMin
      ),
      h('div', { class: 'pm-wd-sec', text: '目录文件触发器参数' }),
      h('div', { class: 'pm-wd-grid' },
        h('label', { text: '目录轮询周期(秒)：' }), f.folderPollSec,
        h('label', { text: '每小时最多触发次数：' }), f.triggerMaxPerHour
      ),
      h('div', { class: 'dlga' },
        h('button', { class: 'btn', type: 'button', text: '取消', onclick: done }),
        h('button', { class: 'btn go', type: 'submit', text: '保存配置' })
      )
    )
  );
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const num = (el, d) => {
      const n = Number(el.value);
      return Number.isFinite(n) && n > 0 ? n : d;
    };
    const patch = {
      idleNudgeMin: num(f.idleNudgeMin, 3),
      idleAlertMin: num(f.idleAlertMin, 10),
      askingAlertMin: num(f.askingAlertMin, 10),
      silentAlertMin: num(f.silentAlertMin, 60),
      loopWindowMin: num(f.loopWindowMin, 10),
      loopCount: num(f.loopCount, 5),
      loopNudge: f.loopNudge.checked,
      autoRestart: f.autoRestart.checked,
      restartWindowMin: num(f.restartWindowMin, 30),
      offlineAlertMin: num(f.offlineAlertMin, 2),
      mentionTimeoutMin: num(f.mentionTimeoutMin, 10),
      swarmStallMin: num(f.swarmStallMin, 5),
      folderPollSec: num(f.folderPollSec, 30),
      triggerMaxPerHour: num(f.triggerMaxPerHour, 6),
    };
    done();
    say('正在保存看门狗参数…');
    const r = await mesh.saveConfig(patch);
    say(r && r.ok ? '已保存看门狗参数 (W1~W8)' : ((r && r.msg) || '保存配置失败'));
  });
  form.addEventListener('keydown', (e) => { if (e.key === 'Escape') { e.stopPropagation(); done(); } });
  const wrap = h('div', { class: 'dlg' }, form);
  wrap.addEventListener('pointerdown', (e) => { if (e.target === wrap) done(); });
  document.body.append(wrap);
  f.mentionTimeoutMin.focus();
}

export function openAddTriggerDialog(proj, { say }) {
  const machines = net.state.sessions.map((m) => m.machine);
  const machSel = h('select', { class: 'field' }, ...machines.map((m) => h('option', { value: m, text: m })));
  const pathIn = h('input', { class: 'field', type: 'text', placeholder: '需在项目授权工作区内，如 /data/cem_results' });
  const wsQuick = (proj.workspaces || []).length ? h('select', {
    class: 'field',
    onchange: (e) => {
      if (!e.target.value) return;
      const [m, p] = e.target.value.split('|');
      machSel.value = m;
      pathIn.value = p;
    },
  },
    h('option', { value: '', text: '— 从项目已授权文件夹快选 —' }),
    ...(proj.workspaces || []).map((w) => h('option', { value: `${w.machine}|${w.path}`, text: `${w.machine} : ${w.path}` }))
  ) : null;
  const globIn = h('input', { class: 'field', type: 'text', value: '*.ffe', placeholder: '如 *.ffe, *.out, *.csv 或 *' });
  const labelIn = h('input', { class: 'field', type: 'text', placeholder: '如：FEKO 远场结果生成触发' });
  const nodeSel = h('select', { class: 'field' },
    h('option', { value: '', text: '（默认通知 Master 主控节点）' }),
    ...(proj.nodes || []).map((n) => h('option', { value: n.id, text: `${n.alias || n.id} (${n.machine})` }))
  );

  const done = () => wrap.remove();
  const form = h('form', { class: 'dlgbox xnote-dlg', autocomplete: 'off' },
    h('div', { class: 'dlgt' }, h('span', { text: '添加跨机目录文件触发器' }), h('button', { class: 'dlgx', type: 'button', text: '×', onclick: done })),
    h('div', { class: 'dlgb' },
      wsQuick ? h('label', { class: 'xnote-lbl', text: '从项目授权工作区选择：' }) : null,
      wsQuick,
      h('label', { class: 'xnote-lbl', text: '监听电脑与目录路径：' }),
      h('div', { style: 'display:flex;gap:6px' }, machSel, pathIn),
      h('label', { class: 'xnote-lbl', text: '文件名匹配通配符与触发器名称：' }),
      h('div', { style: 'display:flex;gap:6px' }, globIn, labelIn),
      h('label', { class: 'xnote-lbl', text: '文件就绪后唤醒的目标节点：' }),
      nodeSel,
      h('div', { class: 'dlga' },
        h('button', { class: 'btn', type: 'button', text: '取消', onclick: done }),
        h('button', { class: 'btn go', type: 'submit', text: '保存并开启监听' })
      )
    )
  );
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (!machSel.value || !pathIn.value.trim()) return;
    done();
    const r = await mesh.trigger({
      projectId: proj.id,
      type: 'folder',
      machine: machSel.value,
      path: pathIn.value.trim(),
      glob: globIn.value.trim() || '*',
      label: labelIn.value.trim(),
      targetNodeId: nodeSel.value || '',
    });
    say(r.ok ? '已添加目录文件触发器' : (r.msg || '添加失败'));
  });
  const wrap = h('div', { class: 'dlg' }, form);
  document.body.append(wrap);
}

export function openSpawnDialog(proj, { say }) {
  const machines = net.state.sessions.map((m) => m.machine);
  const machSel = h('select', { class: 'field' },
    ...machines.map((m) => h('option', { value: m, text: m }))
  );
  const cwdIn = h('input', { class: 'field', type: 'text', placeholder: '例如：/data/cem_solver 或 D:\\feko_data' });
  // Quick-fill from project workspaces
  const wsQuick = (proj.workspaces || []).length ? h('select', {
    class: 'field',
    onchange: (e) => {
      if (!e.target.value) return;
      const [m, p] = e.target.value.split('|');
      machSel.value = m;
      cwdIn.value = p;
    },
  },
    h('option', { value: '', text: '— 快速选择本项目已授权文件夹 —' }),
    ...(proj.workspaces || []).map((w) => h('option', { value: `${w.machine}|${w.path}`, text: `${w.machine} : ${w.path} (${w.tagLabel || w.mode})` }))
  ) : null;

  const toolSel = h('select', { class: 'field' },
    h('option', { value: 'claude', text: 'Claude Code' }),
    h('option', { value: 'agy', text: 'Antigravity (agy)' }),
    h('option', { value: 'codex', text: 'Codex' }),
    h('option', { value: 'opencode', text: 'OpenCode' }),
    h('option', { value: 'kiro', text: 'Kiro CLI' })
  );
  const wsModeSel = h('select', { class: 'field' },
    h('option', { value: 'inherit', text: 'inherit (共用目录)' }),
    h('option', { value: 'worktree', text: 'worktree (独立 Git Worktree 分支)' })
  );
  const branchIn = h('input', {
    class: 'field',
    type: 'text',
    placeholder: '分支名（可选，留空自动生成）',
    disabled: true,
  });
  wsModeSel.addEventListener('change', () => {
    branchIn.disabled = wsModeSel.value !== 'worktree';
    if (branchIn.disabled) branchIn.value = '';
  });
  const aliasIn = h('input', { class: 'field', type: 'text', placeholder: '如：电脑B-FEKO求解Worker' });
  const goalIn = h('input', { class: 'field', type: 'text', placeholder: '如：从 GitHub 拉取最新代码并跑完球体双站 RCS 误差对比' });
  const stopIn = h('input', { class: 'field', type: 'text', value: '产出结果图表与误差数据后立即停下汇报，等待主控会话 Review' });
  const promptIn = h('textarea', { class: 'field xnote-ta', rows: 3, placeholder: '首轮详细执行指令…' });

  const done = () => wrap.remove();
  const form = h('form', { class: 'dlgbox xnote-dlg', autocomplete: 'off' },
    h('div', { class: 'dlgt' }, h('span', { text: '在远程电脑派生新协同节点 (Spawn Worker)' }), h('button', { class: 'dlgx', type: 'button', text: '×', onclick: done })),
    h('div', { class: 'dlgb' },
      wsQuick ? h('label', { class: 'xnote-lbl', text: '从项目工作区快选：' }) : null,
      wsQuick,
      h('label', { class: 'xnote-lbl', text: '目标电脑与工作目录：' }),
      h('div', { style: 'display:flex;gap:6px' }, machSel, cwdIn),
      h('label', { class: 'xnote-lbl', text: '工作区模式与分支名：' }),
      h('div', { style: 'display:flex;gap:6px' }, wsModeSel, branchIn),
      h('label', { class: 'xnote-lbl', text: 'Coding Agent 类型与节点别名：' }),
      h('div', { style: 'display:flex;gap:6px' }, toolSel, aliasIn),
      h('label', { class: 'xnote-lbl', text: '明确目标 (Goal)：' }),
      goalIn,
      h('label', { class: 'xnote-lbl', text: '停机检视边界 (Stop & Review Gate)：' }),
      stopIn,
      h('label', { class: 'xnote-lbl', text: '首轮具体指令：' }),
      promptIn,
      h('div', { class: 'dlga' },
        h('button', { class: 'btn', type: 'button', text: '取消', onclick: done }),
        h('button', { class: 'btn go', type: 'submit', text: '启动并加入拓扑' })
      )
    )
  );
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (!machSel.value || !cwdIn.value.trim()) return;
    const master = (proj.nodes || []).find((n) => n.role === 'master');
    say('正在远程启动协同会话…');
    done();
    const r = await mesh.spawnWorker({
      projectId: proj.id,
      fromNodeId: master ? master.id : undefined,
      machine: machSel.value,
      cwd: cwdIn.value.trim(),
      tool: toolSel.value,
      workspaceMode: wsModeSel.value,
      branch: wsModeSel.value === 'worktree' ? branchIn.value.trim() : '',
      alias: aliasIn.value.trim(),
      goal: goalIn.value.trim(),
      stopCondition: stopIn.value.trim(),
      prompt: promptIn.value.trim() || goalIn.value.trim() || '请按项目契约准备执行任务。',
    });
    say(r.msg || (r.ok ? '已启动' : '启动失败'));
  });
  const wrap = h('div', { class: 'dlg' }, form);
  document.body.append(wrap);
}

export function openBindSessionDialog(proj, { say }) {
  const machines = (net.state.sessions || []).slice().sort((a, b) => {
    if (!!b.online !== !!a.online) return b.online ? 1 : -1;
    return String(a.machine || '').localeCompare(String(b.machine || ''));
  });
  const sessionsByMachine = new Map();
  for (const m of machines) {
    const list = (m.sessions || []).map((s) => ({
      machine: m.machine,
      id: s.id,
      label: s.label || s.id,
      cwd: s.cwd || '',
      state: s.state || 'idle',
      last: Number(s.last || s.t0 || 0),
    }));
    list.sort((a, b) => {
      const score = (st) => (['working', 'thinking', 'reading', 'message', 'waiting'].includes(st) ? 2 : st === 'idle' ? 1 : 0);
      const ds = score(b.state) - score(a.state);
      if (ds !== 0) return ds;
      return b.last - a.last;
    });
    sessionsByMachine.set(m.machine, list);
  }

  const machSel = h('select', { class: 'field' },
    ...machines.map((m) => {
      const cnt = (sessionsByMachine.get(m.machine) || []).length;
      return h('option', {
        value: m.machine,
        text: `${m.machine} (${m.online ? '在线' : '离线'} · ${cnt} 个对话)`,
      });
    })
  );
  const sessSel = h('select', { class: 'field' });
  const renderSessionOptions = () => {
    const mName = machSel.value;
    const list = sessionsByMachine.get(mName) || [];
    if (!list.length) {
      sessSel.replaceChildren(h('option', { value: '', text: '（该电脑当前没有可挂载的对话）' }));
      return;
    }
    sessSel.replaceChildren(...list.map((s) => {
      const dirShort = s.cwd ? ` · ${s.cwd.split(/[\\/]/).filter(Boolean).slice(-1)[0] || s.cwd}` : '';
      return h('option', {
        value: `${s.machine}|${s.id}`,
        text: `${s.label} (${s.state}${dirShort})`,
      });
    }));
  };
  machSel.addEventListener('change', renderSessionOptions);
  renderSessionOptions();

  const allSessions = [...sessionsByMachine.values()].flat();
  const roleSel = h('select', { class: 'field' },
    h('option', { value: 'master', text: 'Master 主控会话（负责统筹与检视）' }),
    h('option', { value: 'worker', text: 'Worker 执行会话（负责子任务计算与汇报）' }),
    h('option', { value: 'verifier', text: 'Verifier 验收会话（只读核查与打回返工）' }),
    h('option', { value: 'peer', text: 'Cowork 平级会话（对等联调协作）' })
  );
  const aliasIn = h('input', { class: 'field', type: 'text', placeholder: '节点别名（可留空使用原会话标题）' });
  const goalIn = h('input', { class: 'field', type: 'text', placeholder: '该节点的职责目标（Goal）' });
  const stopIn = h('input', { class: 'field', type: 'text', placeholder: '停机检视条件（Stop Gate）' });

  const done = () => wrap.remove();
  const form = h('form', { class: 'dlgbox xnote-dlg', autocomplete: 'off' },
    h('div', { class: 'dlgt' }, h('span', { text: '挂载现有会话到项目拓扑' }), h('button', { class: 'dlgx', type: 'button', text: '×', onclick: done })),
    h('div', { class: 'dlgb' },
      h('label', { class: 'xnote-lbl', text: '1. 选择电脑：' }),
      machSel,
      h('label', { class: 'xnote-lbl', text: '2. 选择该电脑上的对话：' }),
      sessSel,
      h('label', { class: 'xnote-lbl', text: '在拓扑中的角色：' }),
      roleSel,
      h('label', { class: 'xnote-lbl', text: '节点别名：' }),
      aliasIn,
      h('label', { class: 'xnote-lbl', text: '负责目标 (Goal)：' }),
      goalIn,
      h('label', { class: 'xnote-lbl', text: '停机检视条件 (Stop Gate)：' }),
      stopIn,
      h('div', { class: 'dlga' },
        h('button', { class: 'btn', type: 'button', text: '取消', onclick: done }),
        h('button', { class: 'btn go', type: 'submit', text: '加入拓扑并同步看板分组' })
      )
    )
  );
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (!sessSel.value) return;
    const [machine, sessionId] = sessSel.value.split('|');
    const picked = allSessions.find((x) => x.machine === machine && x.id === sessionId);
    const master = (proj.nodes || []).find((n) => n.role === 'master');
    done();
    const r = await mesh.upsertNode(proj.id, {
      machine,
      sessionId,
      alias: aliasIn.value.trim() || (picked ? picked.label : sessionId),
      role: roleSel.value,
      cwd: picked ? picked.cwd : '',
      goal: goalIn.value.trim(),
      stopCondition: stopIn.value.trim(),
      fromNodeId: roleSel.value !== 'master' && master ? master.id : undefined,
      edgeType: roleSel.value === 'peer' ? 'cowork' : 'master-worker',
    });
    say(r.ok ? '已挂载节点并自动归入糖糖看板分组' : (r.msg || '挂载失败'));
  });
  const wrap = h('div', { class: 'dlg' }, form);
  document.body.append(wrap);
}

export function openLinkDialog(proj, { say }) {
  const nodes = proj.nodes || [];
  const fromSel = h('select', { class: 'field' }, ...nodes.map((n) => h('option', { value: n.id, text: `${n.alias || n.id} (${n.machine})` })));
  const toSel = h('select', { class: 'field' }, ...nodes.map((n, i) => h('option', { value: n.id, text: `${n.alias || n.id} (${n.machine})`, selected: i === 1 })));
  const typeSel = h('select', { class: 'field' },
    h('option', { value: 'master-worker', text: 'Master → Worker 主从控制与自动汇报边' }),
    h('option', { value: 'cowork', text: 'Cowork ⟷ Cowork 平级对等协作边' })
  );
  const done = () => wrap.remove();
  const form = h('form', { class: 'dlgbox xnote-dlg', autocomplete: 'off' },
    h('div', { class: 'dlgt' }, h('span', { text: '建立会话拓扑连线' }), h('button', { class: 'dlgx', type: 'button', text: '×', onclick: done })),
    h('div', { class: 'dlgb' },
      h('label', { class: 'xnote-lbl', text: '起点节点：' }), fromSel,
      h('label', { class: 'xnote-lbl', text: '终点节点：' }), toSel,
      h('label', { class: 'xnote-lbl', text: '协同关系模式：' }), typeSel,
      h('div', { class: 'dlga' },
        h('button', { class: 'btn', type: 'button', text: '取消', onclick: done }),
        h('button', { class: 'btn go', type: 'submit', text: '建立连线' })
      )
    )
  );
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    done();
    const r = await mesh.addEdge(proj.id, fromSel.value, toSel.value, typeSel.value);
    say(r.ok ? '已建立拓扑连线' : (r.msg || '连线失败'));
  });
  const wrap = h('div', { class: 'dlg' }, form);
  document.body.append(wrap);
}

export function openSendDialog(proj, targetNode, defaultText = '', { say }) {
  const goalIn = h('input', { class: 'field', type: 'text', value: targetNode.goal || '' });
  const stopIn = h('input', { class: 'field', type: 'text', value: targetNode.stopCondition || '' });
  const textIn = h('textarea', { class: 'field xnote-ta', rows: 4, placeholder: '输入要发给该节点的指令或平级协作消息（对方空闲将直接打入终端，正忙则进收件箱）…' });
  textIn.value = defaultText;
  const done = () => wrap.remove();
  const form = h('form', { class: 'dlgbox xnote-dlg', autocomplete: 'off' },
    h('div', { class: 'dlgt' }, h('span', { text: `向节点「${targetNode.alias || targetNode.id}」下发指令 / 修改契约` }), h('button', { class: 'dlgx', type: 'button', text: '×', onclick: done })),
    h('div', { class: 'dlgb' },
      h('label', { class: 'xnote-lbl', text: '阶段目标 (Goal)：' }), goalIn,
      h('label', { class: 'xnote-lbl', text: '停机检视条件 (Stop Gate)：' }), stopIn,
      h('label', { class: 'xnote-lbl', text: '发送消息内容（若只改目标契约不发消息可留空）：' }), textIn,
      h('div', { class: 'dlga' },
        h('button', { class: 'btn', type: 'button', text: '取消', onclick: done }),
        h('button', { class: 'btn go', type: 'submit', text: '确定执行' })
      )
    )
  );
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const msg = textIn.value.trim();
    done();
    if (!msg) {
      await mesh.upsertNode(proj.id, { id: targetNode.id, goal: goalIn.value.trim(), stopCondition: stopIn.value.trim() });
      say('已更新节点目标与停机条件');
      return;
    }
    say('正在投递协同指令…');
    const r = await mesh.sendMessage({
      projectId: proj.id,
      toNodeId: targetNode.id,
      text: msg,
      goal: goalIn.value.trim(),
      stopCondition: stopIn.value.trim(),
    });
    say(r.msg || (r.ok ? '已投递' : '投递失败'));
  });
  const wrap = h('div', { class: 'dlg' }, form);
  document.body.append(wrap);
  textIn.focus();
}

export function openAddWorkspaceDialog(proj, allCat, { say }) {
  if (!allCat.length) {
    openManualWorkspaceDialog(proj, { say });
    return;
  }
  const sel = h('select', { class: 'field' },
    ...allCat.map((c) => h('option', { value: `${c.machine}|${c.path}|${c.tag || ''}`, text: `[${c.machine}] ${c.path} (${c.tagLabel || '无标签'}) ${c.userNote ? '— ' + c.userNote : ''}` }))
  );
  const modeSel = h('select', { class: 'field' },
    h('option', { value: 'rw', text: '读写授权 (RW - 允许改代码/输出数据)' }),
    h('option', { value: 'ro', text: '只读参考 (RO - 仅允许读取参考)' })
  );
  const done = () => wrap.remove();
  const form = h('form', { class: 'dlgbox xnote-dlg', autocomplete: 'off' },
    h('div', { class: 'dlgt' }, h('span', { text: '添加已备注文件夹到项目工作区' }), h('button', { class: 'dlgx', type: 'button', text: '×', onclick: done })),
    h('div', { class: 'dlgb' },
      h('label', { class: 'xnote-lbl', text: '选择文件夹：' }), sel,
      h('label', { class: 'xnote-lbl', text: '访问权限边界：' }), modeSel,
      h('div', { class: 'dlga' },
        h('button', { class: 'btn', type: 'button', text: '取消', onclick: done }),
        h('button', { class: 'btn go', type: 'submit', text: '添加授权' })
      )
    )
  );
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const [machine, path, tag] = sel.value.split('|');
    done();
    const cur = proj.workspaces || [];
    if (cur.some((w) => w.machine === machine && w.path === path)) return say('该文件夹已在项目工作区中');
    await mesh.saveProject({ id: proj.id, name: proj.name, workspaces: [...cur, { machine, path, mode: modeSel.value, tag }] });
    say('已添加项目授权文件夹');
  });
  const wrap = h('div', { class: 'dlg' }, form);
  document.body.append(wrap);
}

export function openManualWorkspaceDialog(proj, { say }) {
  const machines = net.state.sessions.map((m) => m.machine);
  const machSel = h('select', { class: 'field' }, ...machines.map((m) => h('option', { value: m, text: m })));
  const pathIn = h('input', { class: 'field', type: 'text', placeholder: '文件夹绝对路径，如 D:\\CEM_PO 或 /data/feko_runs' });
  const tagSel = h('select', { class: 'field' },
    h('option', { value: 'solver', text: 'CEM求解器 (solver)' }),
    h('option', { value: 'results', text: '求解结果 (results)' }),
    h('option', { value: 'code', text: '核心代码 (code)' }),
    h('option', { value: 'data', text: '数据集 (data)' }),
    h('option', { value: 'docs', text: '文档资料 (docs)' })
  );
  const noteIn = h('input', { class: 'field', type: 'text', placeholder: '我的备注（如：存放高频条带积分结果数据）' });
  const modeSel = h('select', { class: 'field' },
    h('option', { value: 'rw', text: '读写授权 (RW)' }),
    h('option', { value: 'ro', text: '只读参考 (RO)' })
  );
  const done = () => wrap.remove();
  const form = h('form', { class: 'dlgbox xnote-dlg', autocomplete: 'off' },
    h('div', { class: 'dlgt' }, h('span', { text: '手动登记并授权跨机文件夹' }), h('button', { class: 'dlgx', type: 'button', text: '×', onclick: done })),
    h('div', { class: 'dlgb' },
      h('label', { class: 'xnote-lbl', text: '目标电脑与文件夹路径：' }),
      h('div', { style: 'display:flex;gap:6px' }, machSel, pathIn),
      h('label', { class: 'xnote-lbl', text: '角色标签与权限：' }),
      h('div', { style: 'display:flex;gap:6px' }, tagSel, modeSel),
      h('label', { class: 'xnote-lbl', text: '我的备注：' }),
      noteIn,
      h('div', { class: 'dlga' },
        h('button', { class: 'btn', type: 'button', text: '取消', onclick: done }),
        h('button', { class: 'btn go', type: 'submit', text: '保存并同步结构树' })
      )
    )
  );
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (!machSel.value || !pathIn.value.trim()) return;
    const machine = machSel.value, p = pathIn.value.trim();
    done();
    await catalog.setNote({ machine, path: p, tag: tagSel.value, userNote: noteIn.value.trim(), aiNote: '' });
    const cur = proj.workspaces || [];
    if (!cur.some((w) => w.machine === machine && w.path === p)) {
      await mesh.saveProject({ id: proj.id, name: proj.name, workspaces: [...cur, { machine, path: p, mode: modeSel.value, tag: tagSel.value }] });
    }
    say('已保存文件夹备注并授权给当前项目');
  });
  const wrap = h('div', { class: 'dlg' }, form);
  document.body.append(wrap);
}

export function openNewTransferDialog(proj, { say }) {
  const machines = net.state.sessions.map((m) => m.machine);
  const fromM = h('select', { class: 'field' }, ...machines.map((m) => h('option', { value: m, text: m })));
  const fromP = h('input', { class: 'field', type: 'text', placeholder: '源文件路径（如 /data/feko/sphere.h5）' });
  const toM = h('select', { class: 'field' }, ...machines.map((m, i) => h('option', { value: m, text: m, selected: i === 1 })));
  const toP = h('input', { class: 'field', type: 'text', placeholder: '目标存放路径（如 G:\\feko_data\\sphere.h5）' });
  const noteIn = h('input', { class: 'field', type: 'text', placeholder: '备注说明（如：18GB 近场数据，请用移动硬盘拷到电脑A）' });
  const done = () => wrap.remove();
  const form = h('form', { class: 'dlgbox xnote-dlg', autocomplete: 'off' },
    h('div', { class: 'dlgt' }, h('span', { text: '登记大文件移动硬盘人工摆渡请求' }), h('button', { class: 'dlgx', type: 'button', text: '×', onclick: done })),
    h('div', { class: 'dlgb' },
      h('label', { class: 'xnote-lbl', text: '源电脑与文件路径：' }),
      h('div', { style: 'display:flex;gap:6px' }, fromM, fromP),
      h('label', { class: 'xnote-lbl', text: '目标电脑与存放路径：' }),
      h('div', { style: 'display:flex;gap:6px' }, toM, toP),
      h('label', { class: 'xnote-lbl', text: '说明备注：' }),
      noteIn,
      h('div', { class: 'dlga' },
        h('button', { class: 'btn', type: 'button', text: '取消', onclick: done }),
        h('button', { class: 'btn go', type: 'submit', text: '挂起摆渡卡片' })
      )
    )
  );
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (!fromP.value.trim() || !toP.value.trim()) return;
    done();
    const r = await mesh.requestTransfer({
      projectId: proj.id,
      fromMachine: fromM.value,
      fromPath: fromP.value.trim(),
      toMachine: toM.value,
      toPath: toP.value.trim(),
      mode: 'manual_disk',
      note: noteIn.value.trim(),
    });
    say(r.ok ? '已创建大文件人工摆渡卡片' : (r.msg || '创建失败'));
  });
  const wrap = h('div', { class: 'dlg' }, form);
  document.body.append(wrap);
}
