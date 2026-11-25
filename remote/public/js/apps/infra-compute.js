// Mini-Slurm 算力与作业监控子视图（挂载于「网络与设备」应用内）
// 展示各算力机逐卡 GPU 显存/利用率、NUMA/CPU 负载、软件基建能力画像、
// 云算力预留接口（Colab / 云服务器）、运行中/排队中/历史作业列表，支持远程提交、紧急置顶与中止。
import { h, ago } from '../util.js';
import * as net from '../net.js';
import { confirmBox } from '../dialog.js';

function fmtDur(ms) {
  if (!ms || ms < 0) return '—';
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

function gpuPct(g) {
  if (!g || !g.memTotalMiB) return g && g.utilPct ? Math.round(g.utilPct) : 0;
  return Math.min(100, Math.max(0, Math.round((g.memUsedMiB / g.memTotalMiB) * 100)));
}

export function createComputeView({ say = () => {} } = {}) {
  let data = { jobs: [], machines: [], providers: [] };
  let projects = [];
  let loading = false;

  const root = h('div', { class: 'inf-comp' });
  const headBar = h('div', { class: 'inf-comp-head' });
  const leftCol = h('div', { class: 'inf-comp-left' });
  const rightCol = h('div', { class: 'inf-comp-right' });
  const grid = h('div', { class: 'inf-comp-grid' }, leftCol, rightCol);
  root.append(headBar, grid);

  async function refresh() {
    if (loading) return;
    loading = true;
    try {
      const [qRes, pRes] = await Promise.all([
        fetch('/api/mesh/queue').then((r) => r.json()).catch(() => null),
        fetch('/api/mesh/projects').then((r) => r.json()).catch(() => null),
      ]);
      if (qRes && qRes.ok) data = qRes;
      if (pRes && pRes.ok && Array.isArray(pRes.projects)) projects = pRes.projects;
      render();
    } finally {
      loading = false;
    }
  }

  async function postQueue(payload, okMsg) {
    const r = await net.post('/api/mesh/queue', payload);
    if (!r || !r.ok) {
      say((r && r.msg) || '操作失败');
      return false;
    }
    if (okMsg) say(okMsg);
    await refresh();
    return true;
  }

  function openProfileDialog(m) {
    const roleIn = h('input', { class: 'field', type: 'text', value: m.role || '', placeholder: '如：双卡 4090 主力求解站' });
    const hwIn = h('input', { class: 'field', type: 'text', value: m.hardware || '', placeholder: '如：2x RTX 4090 24GB, 2x Xeon 6230R, 125GB RAM' });
    const swIn = h('input', { class: 'field', type: 'text', value: m.software || '', placeholder: '如：Linux, Conda cem_occ, CuPy, PyTorch, numactl（或 Windows, FEKO）' });
    const noteIn = h('textarea', { class: 'field', rows: 3, placeholder: '能力边界、数据目录约定、使用注意事项（自动喂给 Master 决策）' });
    noteIn.value = m.note || '';

    const done = () => wrap.remove();
    const form = h('form', { class: 'dlgbox xnote-dlg', autocomplete: 'off' },
      h('div', { class: 'dlgt' }, h('span', { text: `编辑算力机能力画像 — ${m.machine}` }), h('button', { class: 'dlgx', type: 'button', text: '×', onclick: done })),
      h('div', { class: 'dlgb' },
        h('label', { class: 'xnote-lbl', text: '机器定位（Role）：' }), roleIn,
        h('label', { class: 'xnote-lbl', text: '硬件配置（Hardware）：' }), hwIn,
        h('label', { class: 'xnote-lbl', text: '软件基建与求解环境（Software）：' }), swIn,
        h('label', { class: 'xnote-lbl', text: '能力边界与备注（Note）：' }), noteIn,
        h('div', { class: 'dlga' },
          h('button', { class: 'btn', type: 'button', text: '取消', onclick: done }),
          h('button', { class: 'btn go', type: 'submit', text: '保存画像' })
        )
      )
    );
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      done();
      const r = await net.post('/api/mesh/machine-profiles', {
        machine: m.machine,
        role: roleIn.value.trim(),
        hardware: hwIn.value.trim(),
        software: swIn.value.trim(),
        note: noteIn.value.trim(),
      });
      if (r && r.ok) {
        say(`已保存 ${m.machine} 能力画像`);
        await refresh();
      } else {
        say((r && r.msg) || '保存失败');
      }
    });
    const wrap = h('div', { class: 'dlg' }, form);
    document.body.append(wrap);
  }

  function openSubmitDialog(defaultMachine = '', opts = {}) {
    const onlineMachines = (data.machines || []).filter((m) => m.online && m.control);
    const machList = onlineMachines.length ? onlineMachines : (data.machines || []);
    const colabProv = (data.providers || []).find((p) => p.id === 'colab') || null;
    const colabMeta = (colabProv && colabProv.meta) || {};
    const colabBalTxt = colabProv && colabProv.status === 'active' && colabMeta.balanceCcu != null
      ? ` [余 ${Number(colabMeta.balanceCcu).toFixed(1)} CCU]`
      : '';

    const provSel = h('select', { class: 'field' },
      h('option', { value: 'local-agent', text: '本地算力机 (Agent)' }),
      h('option', { value: 'colab', text: `Google Colab (A100/L4/T4)${colabBalTxt}` })
    );
    if (opts && opts.providerType === 'colab') provSel.value = 'colab';

    const machSel = h('select', { class: 'field' },
      ...machList.map((m) => h('option', { value: m.machine, text: `${m.machine}${m.online ? '' : ' (离线)'}` }))
    );
    if (defaultMachine) machSel.value = defaultMachine;

    const projSel = h('select', { class: 'field' },
      h('option', { value: '', text: '（不绑定项目，仅在算力面板查看）' }),
      ...projects.map((p) => h('option', { value: p.id, text: `${p.name} (${p.id})` }))
    );
    const resSel = h('select', { class: 'field' },
      h('option', { value: 'gpu', text: 'GPU 算力' }),
      h('option', { value: 'cpu', text: 'CPU / NUMA 算力' })
    );
    const countIn = h('input', { class: 'field', type: 'text', value: '1', placeholder: '1 / 2 / all' });
    const prioSel = h('select', { class: 'field' },
      h('option', { value: 'normal', text: '普通 (normal)' }),
      h('option', { value: 'urgent', text: '紧急插队 (urgent)' }),
      h('option', { value: 'low', text: '低优 (low)' })
    );

    const colabGpuSel = h('select', { class: 'field' },
      h('option', { value: 'A100', text: 'A100 (缺货自动降级 L4 -> T4)' }),
      h('option', { value: 'L4', text: 'L4 (缺货自动降级 T4)' }),
      h('option', { value: 'T4', text: 'T4' })
    );
    const maxDurIn = h('input', { class: 'field', type: 'number', min: '1', max: '720', value: '120', placeholder: '120' });
    const minCcuIn = h('input', { class: 'field', type: 'number', min: '0', step: '1', value: '15', placeholder: '15' });
    const dlPathIn = h('input', { class: 'field', type: 'text', placeholder: 'Colab 远端产物路径（留空则不下载）' });
    const outDirIn = h('input', { class: 'field', type: 'text', placeholder: '网关机本地保存目录，如：/mnt/nas/colab-out' });

    const labelIn = h('input', { class: 'field', type: 'text', placeholder: '作业名称，如：CEM 扫频验证' });
    const cwdIn = h('input', { class: 'field', type: 'text', placeholder: '工作目录绝对路径（留空则用目标机主目录）' });
    const cmdIn = h('textarea', { class: 'field', rows: 3, placeholder: '要执行的完整命令，如：python3 solve.py --freq 10e9' });

    const localMachWrap = h('div', {}, h('label', { class: 'xnote-lbl', text: '目标算力机：' }), machSel);
    const localResRow = h('div', { style: 'display:grid;grid-template-columns:1fr 1fr;gap:8px' },
      h('div', {}, h('label', { class: 'xnote-lbl', text: '资源类型：' }), resSel),
      h('div', {}, h('label', { class: 'xnote-lbl', text: '卡数 / NUMA 路数：' }), countIn)
    );
    const colabSection = h('div', {},
      h('div', { style: 'display:grid;grid-template-columns:2fr 1fr 1fr;gap:8px' },
        h('div', {}, h('label', { class: 'xnote-lbl', text: 'Colab GPU 型号：' }), colabGpuSel),
        h('div', {}, h('label', { class: 'xnote-lbl', text: '最大时长 (分钟)：' }), maxDurIn),
        h('div', {}, h('label', { class: 'xnote-lbl', text: '余额红线 (CCU)：' }), minCcuIn)
      ),
      h('div', { style: 'display:grid;grid-template-columns:1fr 1fr;gap:8px' },
        h('div', {}, h('label', { class: 'xnote-lbl', text: '远端下载路径 (可选)：' }), dlPathIn),
        h('div', {}, h('label', { class: 'xnote-lbl', text: '产物保存目录 (如 /mnt/nas/...)：' }), outDirIn)
      ),
      h('div', {
        class: 'inf-comp-muted',
        style: 'margin:4px 0',
        text: colabMeta.machine
          ? `Colab 网关机：${colabMeta.machine}（结束后强制执行 colab stop 停表）`
          : '提示：尚未检测到上报 colab-status 的网关机，提交后需等待网关机上线。',
      })
    );

    const syncProviderMode = () => {
      const isColab = provSel.value === 'colab';
      localMachWrap.style.display = isColab ? 'none' : '';
      localResRow.style.display = isColab ? 'none' : 'grid';
      colabSection.style.display = isColab ? '' : 'none';
    };
    provSel.addEventListener('change', syncProviderMode);
    syncProviderMode();

    const done = () => wrap.remove();
    const form = h('form', { class: 'dlgbox xnote-dlg', autocomplete: 'off' },
      h('div', { class: 'dlgt' }, h('span', { text: '远程提交计算作业（零 AI 监工）' }), h('button', { class: 'dlgx', type: 'button', text: '×', onclick: done })),
      h('div', { class: 'dlgb' },
        h('div', { style: 'display:grid;grid-template-columns:1fr 1fr;gap:8px' },
          h('div', {}, h('label', { class: 'xnote-lbl', text: '算力提供方 (Provider)：' }), provSel),
          h('div', {}, h('label', { class: 'xnote-lbl', text: '关联项目（结果自动回传）：' }), projSel)
        ),
        h('div', { style: 'display:grid;grid-template-columns:1fr 1fr;gap:8px' },
          localMachWrap,
          h('div', {}, h('label', { class: 'xnote-lbl', text: '优先级：' }), prioSel)
        ),
        localResRow,
        colabSection,
        h('label', { class: 'xnote-lbl', text: '作业名称（Label）：' }), labelIn,
        h('label', { class: 'xnote-lbl', text: '工作目录（cwd）：' }), cwdIn,
        h('label', { class: 'xnote-lbl', text: '执行命令（Command）：' }), cmdIn,
        h('div', { class: 'dlga' },
          h('button', { class: 'btn', type: 'button', text: '取消', onclick: done }),
          h('button', { class: 'btn go', type: 'submit', text: '入队执行' })
        )
      )
    );
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const command = cmdIn.value.trim();
      const isColab = provSel.value === 'colab';
      if (!command) return;
      if (!isColab && !machSel.value) return;
      done();
      if (isColab) {
        const gpu = colabGpuSel.value || 'A100';
        const fallbackGpus = gpu === 'A100' ? ['L4', 'T4'] : gpu === 'L4' ? ['T4'] : [];
        await postQueue({
          op: 'submit',
          providerType: 'colab',
          machine: colabMeta.machine || '',
          projectId: projSel.value,
          resource: 'gpu',
          colabGpu: gpu,
          fallbackGpus,
          maxDurationMin: Number(maxDurIn.value) || 120,
          minBalanceCcu: minCcuIn.value !== '' ? Number(minCcuIn.value) : 15,
          downloadPath: dlPathIn.value.trim(),
          outputDir: outDirIn.value.trim(),
          priority: prioSel.value,
          label: labelIn.value.trim() || command.slice(0, 50),
          cwd: cwdIn.value.trim(),
          command,
        }, `已提交 Google Colab (${gpu}) 作业`);
      } else {
        const rawCnt = countIn.value.trim();
        const cntVal = rawCnt.toLowerCase() === 'all' ? 'all' : (Number(rawCnt) || 1);
        await postQueue({
          op: 'submit',
          providerType: 'local-agent',
          machine: machSel.value,
          projectId: projSel.value,
          resource: resSel.value,
          ...(resSel.value === 'gpu' ? { gpus: cntVal } : { numa: cntVal }),
          priority: prioSel.value,
          label: labelIn.value.trim() || command.slice(0, 50),
          cwd: cwdIn.value.trim(),
          command,
        }, `已提交作业至 ${machSel.value}`);
      }
    });
    const wrap = h('div', { class: 'dlg' }, form);
    document.body.append(wrap);
  }

  function renderMachineCard(m) {
    const comp = m.compute || {};
    const gpus = Array.isArray(comp.gpus) ? comp.gpus : [];
    const gpuRows = gpus.length
      ? gpus.map((g) => {
          const pct = gpuPct(g);
          const statusTxt = g.managedBy ? `作业 ${g.managedBy}` : g.busy ? '外部占用' : '空闲';
          const cls = g.managedBy ? 'warn' : g.busy ? 'err' : '';
          const memTxt = g.memTotalMiB ? `${Math.round(g.memUsedMiB)}/${Math.round(g.memTotalMiB)} MiB` : `${g.utilPct || 0}%`;
          return h('div', { class: 'inf-comp-gpu' },
            h('span', { class: 'inf-comp-glbl', text: `GPU${g.index}${g.numaNode != null ? ` (N${g.numaNode})` : ''}` }),
            h('div', { class: 'inf-meter' }, h('i', { class: cls, style: `width:${pct}%` })),
            h('span', { class: 'inf-comp-gval', text: `${memTxt} · ${statusTxt}` })
          );
        })
      : [h('div', { class: 'inf-comp-muted', text: '无独立 NVIDIA GPU（仅 CPU 槽位）' })];

    const dirs = Array.isArray(m.computeDirs) ? m.computeDirs.slice(0, 4) : [];
    return h('div', { class: `inf-comp-card${m.online ? '' : ' off'}` },
      h('div', { class: 'inf-comp-card-hd' },
        h('span', { class: `inf-dot ${m.online ? 'on' : ''}` }),
        h('b', { text: m.machine }),
        h('span', { class: 'inf-comp-tag', text: m.role || (comp.hasGpu ? 'GPU 算力机' : '计算节点') }),
        h('span', { style: 'margin-left:auto;font-size:10px;color:var(--muted)', text: `运行 ${comp.runningCount || 0} / 排队 ${comp.queuedCount || 0}` }),
        h('button', { class: 'btn', type: 'button', style: 'padding:1px 6px;font-size:10px', text: '画像', onclick: () => openProfileDialog(m) }),
        m.online && m.control
          ? h('button', { class: 'btn', type: 'button', style: 'padding:1px 6px;font-size:10px', text: '投作业', onclick: () => openSubmitDialog(m.machine) })
          : null
      ),
      ...gpuRows,
      h('div', { class: 'inf-comp-meta' },
        h('span', { text: `CPU: ${comp.cpuCount || '—'} 核 / ${comp.numaCount || 1} NUMA${comp.cpuBusy ? ' (忙)' : ''}` }),
        m.software ? h('span', { class: 'inf-comp-sw', text: `软件基建: ${m.software}` }) : null,
        m.note ? h('span', { class: 'inf-comp-muted', text: m.note }) : null
      ),
      dirs.length
        ? h('div', { class: 'inf-comp-dirs' },
            ...dirs.map((d) => h('span', { class: 'inf-comp-dir', text: `${d.path}${d.gitBranch ? ` [${d.gitBranch}]` : ''}` }))
          )
        : null
    );
  }

  function renderJobRow(j, isActive) {
    const slotTxt = j.providerType === 'colab'
      ? `Colab ${j.colabGpu || 'A100'}`
      : (j.resource === 'gpu'
        ? `GPU[${(j.assignedGpus || []).length ? j.assignedGpus.join(',') : (j.gpus || 1)}]`
        : `NUMA[${(j.assignedNuma || []).length ? j.assignedNuma.join(',') : (j.numa || 1)}]`);
    const prioCls = j.priority === 'urgent' ? ' err' : '';
    const dur = j.status === 'running' && j.startedAt
      ? fmtDur(Date.now() - j.startedAt)
      : (j.durationMs ? fmtDur(j.durationMs) : (j.endedAt && j.startedAt ? fmtDur(j.endedAt - j.startedAt) : '—'));
    return h('div', { class: `inf-comp-job ${j.status}` },
      h('div', { class: 'inf-comp-job-hd' },
        h('span', { class: `inf-comp-badge ${j.status}`, text: j.status.toUpperCase() }),
        h('span', { class: `inf-comp-badge${prioCls}`, text: j.priority || 'normal' }),
        h('b', { text: j.label || j.id }),
        h('span', { class: 'inf-comp-muted', text: `${j.machine} · ${slotTxt} · ${dur}` }),
        h('div', { style: 'margin-left:auto;display:flex;gap:4px' },
          j.status === 'queued' && j.priority !== 'urgent'
            ? h('button', { class: 'btn', type: 'button', style: 'padding:1px 6px;font-size:10px', text: '置顶', onclick: () => postQueue({ op: 'prioritize', jobId: j.id, priority: 'urgent' }, `已置顶 ${j.label}`) })
            : null,
          isActive
            ? h('button', {
                class: 'btn',
                type: 'button',
                style: 'padding:1px 6px;font-size:10px',
                text: j.status === 'running' ? '中止' : '取消',
                onclick: async () => {
                  if (await confirmBox(`确定${j.status === 'running' ? '中止' : '取消'}作业「${j.label}」吗？`)) {
                    await postQueue({ op: 'cancel', jobId: j.id }, `已取消作业 ${j.label}`);
                  }
                },
              })
            : null
        )
      ),
      j.command ? h('div', { class: 'inf-comp-cmd', text: `${j.cwd ? `[${j.cwd}] ` : ''}${j.command}` }) : null,
      j.waitReason ? h('div', { class: 'inf-comp-muted', text: `等待原因: ${j.waitReason}` }) : null,
      j.reason ? h('div', { class: 'inf-comp-muted', text: `结果说明: ${j.reason}${j.exitCode != null ? ` (exit ${j.exitCode})` : ''}` }) : null,
      j.tail ? h('pre', { class: 'inf-comp-tail', text: j.tail.slice(-400) }) : null
    );
  }

  function render() {
    const jobs = Array.isArray(data.jobs) ? data.jobs : [];
    const running = jobs.filter((j) => j.status === 'running');
    const queued = jobs.filter((j) => j.status === 'queued');
    const history = jobs.filter((j) => j.status !== 'running' && j.status !== 'queued').slice(-15).reverse();
    const machs = Array.isArray(data.machines) ? data.machines : [];
    const providers = Array.isArray(data.providers) ? data.providers : [];

    const totalGpus = machs.reduce((s, m) => s + ((m.compute && m.compute.gpus && m.compute.gpus.length) || 0), 0);
    const freeGpus = machs.reduce((s, m) => s + ((m.compute && m.compute.gpus) || []).filter((g) => !g.busy && !g.managedBy).length, 0);

    headBar.replaceChildren(
      h('span', { class: 'inf-stat-pill ok', text: `空闲 GPU ${freeGpus} / ${totalGpus}` }),
      h('span', { class: 'inf-stat-pill', text: `运行中 ${running.length}` }),
      h('span', { class: 'inf-stat-pill', text: `排队中 ${queued.length}` }),
      h('div', { class: 'inf-bar-right' },
        h('button', { class: 'btn go', type: 'button', text: '+ 远程提交算例', onclick: () => openSubmitDialog('') }),
        h('button', { class: 'btn', type: 'button', text: '清空历史', onclick: () => postQueue({ op: 'clear_done' }, '已清空已完成作业历史') }),
        h('button', { class: 'btn', type: 'button', text: '刷新队列', onclick: refresh })
      )
    );

    const sortedMachines = [...machs].sort((a, b) =>
      ((b.online ? 1 : 0) - (a.online ? 1 : 0)) ||
      (((b.compute && b.compute.hasGpu) ? 1 : 0) - ((a.compute && a.compute.hasGpu) ? 1 : 0)) ||
      String(a.machine).localeCompare(String(b.machine))
    );

    leftCol.replaceChildren(
      h('div', { class: 'inf-comp-sec-hd', text: '算力节点与能力画像（供 Master 决策）' }),
      ...(sortedMachines.length ? sortedMachines.map(renderMachineCard) : [h('div', { class: 'inf-comp-muted', text: '暂无在线算力机' })]),
      h('div', { class: 'inf-comp-sec-hd', style: 'margin-top:10px', text: '云算力与外部超算扩展槽' }),
      ...providers.filter((p) => p.id !== 'local-agent').map((p) => {
        const meta = (p && p.meta && typeof p.meta === 'object') ? p.meta : null;
        const statusTxt = p.status === 'active' ? '已接入' : p.status === 'offline' ? '暂不可用' : '已预留接口';
        if (p.id === 'colab' && meta) {
          const balTxt = meta.balanceCcu != null ? `${Number(meta.balanceCcu).toFixed(2)} CCU` : '—';
          const rateTxt = meta.burnRatePerHour != null ? `${Number(meta.burnRatePerHour).toFixed(2)} CCU/h` : '0.00 CCU/h';
          const actTxt = String(meta.activeRuntimes != null ? meta.activeRuntimes : 0);
          return h('div', { class: 'inf-comp-provider' },
            h('div', { style: 'display:flex;align-items:center;gap:6px;flex-wrap:wrap' },
              h('span', { class: `inf-dot ${p.status === 'active' ? 'on' : ''}` }),
              h('b', { text: p.name }),
              h('span', { class: 'inf-comp-tag', text: statusTxt }),
              p.status === 'active'
                ? h('button', {
                    class: 'btn',
                    type: 'button',
                    style: 'margin-left:auto;padding:1px 6px;font-size:10px',
                    text: '投 Colab',
                    onclick: () => openSubmitDialog('', { providerType: 'colab' }),
                  })
                : null
            ),
            h('div', { class: 'inf-comp-meta', style: 'margin-top:4px' },
              h('span', { text: `网关机: ${meta.machine || '—'}` }),
              h('span', { text: `剩余 CCU: ${balTxt}` }),
              h('span', { text: `消耗率: ${rateTxt}` }),
              h('span', { text: `活动运行时: ${actTxt}` }),
              meta.at ? h('span', { class: 'inf-comp-muted', text: `更新于 ${ago(meta.at)}` }) : null
            ),
            meta.error ? h('div', { class: 'inf-comp-muted', text: `状态异常: ${meta.error}` }) : null
          );
        }
        return h('div', { class: 'inf-comp-provider' },
          h('b', { text: p.name }),
          h('span', { class: 'inf-comp-tag', text: statusTxt }),
          h('div', { class: 'inf-comp-muted', text: p.note || '' })
        );
      })
    );

    rightCol.replaceChildren(
      h('div', { class: 'inf-comp-sec-hd', text: `运行中作业 (${running.length})` }),
      ...(running.length ? running.map((j) => renderJobRow(j, true)) : [h('div', { class: 'inf-comp-muted', text: '当前无运行中作业' })]),
      h('div', { class: 'inf-comp-sec-hd', style: 'margin-top:10px', text: `排队中作业 (${queued.length})` }),
      ...(queued.length ? queued.map((j) => renderJobRow(j, true)) : [h('div', { class: 'inf-comp-muted', text: '当前无排队作业' })]),
      h('div', { class: 'inf-comp-sec-hd', style: 'margin-top:10px', text: `近期历史 (${history.length})` }),
      ...(history.length ? history.map((j) => renderJobRow(j, false)) : [h('div', { class: 'inf-comp-muted', text: '暂无历史记录' })])
    );
  }

  return { root, refresh };
}
