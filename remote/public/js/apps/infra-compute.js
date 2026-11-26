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
  let fableAdvice = null;
  let fableForce = false;
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
      const [qRes, pRes, fRes] = await Promise.all([
        fetch('/api/mesh/queue').then((r) => r.json()).catch(() => null),
        fetch('/api/mesh/projects').then((r) => r.json()).catch(() => null),
        fetch(`/api/mesh/fable-advice${fableForce ? '?force=1' : ''}`).then((r) => r.json()).catch(() => null),
      ]);
      if (qRes && qRes.ok) data = qRes;
      if (pRes && pRes.ok && Array.isArray(pRes.projects)) projects = pRes.projects;
      if (fRes && fRes.ok) fableAdvice = fRes;
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
    const sugonProv = (data.providers || []).find((p) => p.id === 'sugon') || null;
    const sugonMeta = (sugonProv && sugonProv.meta) || {};
    const sugonModeTxt = sugonProv && sugonProv.status === 'active'
      ? ` [${sugonMeta.mode === 'openapi' ? 'OpenAPI' : 'SSH+Slurm'}${sugonMeta.defaultPartition ? `/${sugonMeta.defaultPartition}` : ''}]`
      : '';

    const provSel = h('select', { class: 'field' },
      h('option', { value: 'local-agent', text: '本地算力机 (Agent)' }),
      h('option', { value: 'colab', text: `Google Colab (A100/L4/T4)${colabBalTxt}` }),
      h('option', { value: 'sugon', text: `曙光超算 / SCNet${sugonModeTxt}` })
    );
    if (opts && (opts.providerType === 'colab' || opts.providerType === 'sugon')) provSel.value = opts.providerType;

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
    const dlPathIn = h('input', { class: 'field', type: 'text', placeholder: '远端产物路径（留空则不下载）' });
    const outDirIn = h('input', { class: 'field', type: 'text', placeholder: '网关机本地保存目录，如：/mnt/nas/colab-out' });

    const sugonProfiles = Array.isArray(sugonMeta.profiles) ? sugonMeta.profiles : [];
    const sugonProfSel = h('select', { class: 'field' },
      ...(sugonProfiles.length
        ? sugonProfiles.map((pf) => h('option', {
            value: pf.id,
            text: `${pf.label || pf.id}${pf.hasRayfile ? ' [快传]' : ''}${pf.available ? '' : ' (离线)'}`,
          }))
        : [h('option', { value: '', text: '默认配置档' })])
    );
    if (sugonMeta.defaultProfile && sugonProfiles.some((pf) => pf.id === sugonMeta.defaultProfile)) {
      sugonProfSel.value = sugonMeta.defaultProfile;
    }
    const sugonPartIn = h('input', { class: 'field', type: 'text', value: sugonMeta.defaultPartition || '', placeholder: '分区名，如：hfacnormal04 / ksagnormal01' });
    const sugonNodesIn = h('input', { class: 'field', type: 'number', min: '1', max: '128', value: '1', placeholder: '1' });
    const sugonTasksIn = h('input', { class: 'field', type: 'number', min: '1', max: '4096', value: '1', placeholder: '1' });
    const sugonGpusIn = h('input', { class: 'field', type: 'number', min: '0', max: '16', value: '0', placeholder: '0' });
    const sugonWallIn = h('input', { class: 'field', type: 'text', value: '04:00:00', placeholder: 'HH:MM:SS，如 04:00:00' });
    const sugonWorkIn = h('input', { class: 'field', type: 'text', value: sugonMeta.remoteWorkDir || '', placeholder: '超算远端工作目录（留空用配置默认）' });
    const sugonDlIn = h('input', { class: 'field', type: 'text', placeholder: '超算远端产物路径（留空则不回传）' });
    const sugonOutIn = h('input', { class: 'field', type: 'text', value: '/mnt/nas/sugon-out', placeholder: '网关机保存目录，如：/mnt/nas/sugon-out' });

    const syncSugonProfileDefaults = () => {
      const pf = sugonProfiles.find((x) => x.id === sugonProfSel.value);
      if (!pf) return;
      if (pf.defaultPartition) sugonPartIn.value = pf.defaultPartition;
      if (pf.remoteWorkDir) sugonWorkIn.value = pf.remoteWorkDir;
    };
    sugonProfSel.addEventListener('change', syncSugonProfileDefaults);
    syncSugonProfileDefaults();

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
    const sugonSection = h('div', {},
      h('div', { style: 'margin-bottom:4px' },
        h('label', { class: 'xnote-lbl', text: '超算中心与账号 (Profile)：' }), sugonProfSel
      ),
      h('div', { style: 'display:grid;grid-template-columns:2fr 1fr 1fr 1fr;gap:8px' },
        h('div', {}, h('label', { class: 'xnote-lbl', text: '队列分区 (Partition)：' }), sugonPartIn),
        h('div', {}, h('label', { class: 'xnote-lbl', text: '节点数：' }), sugonNodesIn),
        h('div', {}, h('label', { class: 'xnote-lbl', text: '核数 (ntasks)：' }), sugonTasksIn),
        h('div', {}, h('label', { class: 'xnote-lbl', text: 'GPU/DCU 卡数：' }), sugonGpusIn)
      ),
      h('div', { style: 'display:grid;grid-template-columns:1fr 2fr;gap:8px' },
        h('div', {}, h('label', { class: 'xnote-lbl', text: '最大墙钟时长 (Walltime)：' }), sugonWallIn),
        h('div', {}, h('label', { class: 'xnote-lbl', text: '超算远端工作目录 (可选)：' }), sugonWorkIn)
      ),
      h('div', { style: 'display:grid;grid-template-columns:1fr 1fr;gap:8px' },
        h('div', {}, h('label', { class: 'xnote-lbl', text: '远端回传路径 (可选)：' }), sugonDlIn),
        h('div', {}, h('label', { class: 'xnote-lbl', text: 'NAS 保存目录 (如 /mnt/nas/...)：' }), sugonOutIn)
      ),
      h('div', {
        class: 'inf-comp-muted',
        style: 'margin:4px 0',
        text: sugonMeta.machine
          ? `曙光网关机：${sugonMeta.machine}（模式：${sugonMeta.mode === 'openapi' ? 'OpenAPI v2' : 'SSH + Slurm'}）`
          : '提示：尚未检测到配置 ~/.config/ame-hpc/sugon.json 的网关机，详见 docs/sugon-hpc-guide.md。',
      })
    );

    const syncProviderMode = () => {
      const mode = provSel.value;
      const isLocal = mode === 'local-agent';
      localMachWrap.style.display = isLocal ? '' : 'none';
      localResRow.style.display = isLocal ? 'grid' : 'none';
      colabSection.style.display = mode === 'colab' ? '' : 'none';
      sugonSection.style.display = mode === 'sugon' ? '' : 'none';
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
        sugonSection,
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
      const mode = provSel.value;
      if (!command) return;
      if (mode === 'local-agent' && !machSel.value) return;
      done();
      if (mode === 'colab') {
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
      } else if (mode === 'sugon') {
        const gpus = Math.max(0, Number(sugonGpusIn.value) || 0);
        await postQueue({
          op: 'submit',
          providerType: 'sugon',
          sugonProfile: sugonProfSel.value || '',
          machine: sugonMeta.machine || '',
          projectId: projSel.value,
          resource: gpus > 0 ? 'gpu' : 'cpu',
          gpus,
          partition: sugonPartIn.value.trim(),
          nodes: Math.max(1, Number(sugonNodesIn.value) || 1),
          ntasks: Math.max(1, Number(sugonTasksIn.value) || 1),
          walltime: sugonWallIn.value.trim() || '02:00:00',
          remoteWorkDir: sugonWorkIn.value.trim(),
          downloadPath: sugonDlIn.value.trim(),
          outputDir: sugonOutIn.value.trim(),
          priority: prioSel.value,
          label: labelIn.value.trim() || command.slice(0, 50),
          cwd: cwdIn.value.trim(),
          command,
        }, `已提交曙光超算作业 (${sugonPartIn.value.trim() || '默认分区'})`);
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
      : j.providerType === 'sugon'
        ? `Sugon ${j.partition || '默认'} (${j.nodes || 1}N/${j.ntasks || 1}T${j.gpus ? `/${j.gpus}G` : ''})`
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

  function openFableLaunchDialog(s, sortedMachines) {
    const onlineCtrl = (sortedMachines || []).filter((m) => m.online && m.control);
    const machList = onlineCtrl.length ? onlineCtrl : (sortedMachines || []);
    const defaultMach = s.machine || (machList[0] ? machList[0].machine : '');
    const defaultDir = s.cwd || ((machList.find((m) => m.machine === defaultMach)?.computeDirs || [])[0]?.path) || '';

    const machSel = h('select', { class: 'field' },
      ...machList.map((m) => h('option', { value: m.machine, text: `${m.machine}${m.online ? '' : ' (离线)'}` }))
    );
    if (defaultMach) machSel.value = defaultMach;
    const cwdIn = h('input', { class: 'field', type: 'text', value: defaultDir, placeholder: '目标机器上的项目/工作目录绝对路径' });

    const done = () => wrap.remove();
    const form = h('form', { class: 'dlgbox xnote-dlg', autocomplete: 'off' },
      h('div', { class: 'dlgt' }, h('span', { text: '派发 Fable 5.2 只读顾问会话' }), h('button', { class: 'dlgx', type: 'button', text: '×', onclick: done })),
      h('div', { class: 'dlgb' },
        h('div', { class: 'inf-comp-muted', style: 'margin-bottom:6px', text: `难题：${s.title}` }),
        h('label', { class: 'xnote-lbl', text: '运行 OpenCode 顾问的机器：' }), machSel,
        h('label', { class: 'xnote-lbl', text: '工作目录（cwd）：' }), cwdIn,
        h('div', { class: 'dlga' },
          h('button', { class: 'btn', type: 'button', text: '取消', onclick: done }),
          h('button', { class: 'btn go', type: 'submit', text: '启动只读顾问' })
        )
      )
    );
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const mach = machSel.value;
      const cwd = cwdIn.value.trim();
      if (!mach || !cwd) { say('请指定目标机器与工作目录'); return; }
      done();
      const r = await net.post('/api/mesh/fable-advice/launch', {
        projectId: s.projectId || '',
        machine: mach,
        cwd,
        title: s.title,
        advisorPrompt: s.advisorPrompt,
      });
      if (r && r.ok) say(`已在 ${mach} 启动 Fable 5.2 只读顾问：${s.title.slice(0, 32)}`);
      else say((r && r.msg) || '启动 Fable 顾问失败');
    });
    const wrap = h('div', { class: 'dlg' }, form);
    document.body.append(wrap);
  }

  function renderFableAdvisorCard(sortedMachines) {
    const adv = fableAdvice;
    const win = adv && adv.window;
    const sugs = (adv && Array.isArray(adv.suggestions)) ? adv.suggestions : [];
    const statusBadge = !adv
      ? '检测中'
      : adv.due
        ? '临近到期 · 建议消化'
        : adv.preview
          ? '预览模式'
          : adv.exhausted
            ? '额度已耗尽'
            : adv.found
              ? '未达到期阈值'
              : '未接入 Devin';

    const winTxt = win
      ? `${win.name || '窗口'} 余 ${win.remainingPct != null ? `${win.remainingPct}%` : '—'}${win.hoursLeft != null ? ` · ${win.hoursLeft}h 后重置` : ''}`
      : (adv && adv.reason ? adv.reason : '等待 Magpie 上报 Devin 窗口数据');

    return h('div', {},
      h('div', { class: 'inf-comp-sec-hd', style: 'margin-top:10px;display:flex;align-items:center;gap:6px' },
        h('span', { text: 'Devin / Fable 5.2 难题顾问（只读拍板）' }),
        h('button', {
          class: 'btn',
          type: 'button',
          style: 'margin-left:auto;padding:1px 6px;font-size:10px',
          text: fableForce ? '切回自动触发' : '预览推荐难题',
          onclick: () => { fableForce = !fableForce; refresh(); },
        })
      ),
      h('div', { class: 'inf-comp-provider' },
        h('div', { style: 'display:flex;align-items:center;gap:6px;flex-wrap:wrap' },
          h('span', { class: `inf-dot ${adv && adv.due ? 'on' : ''}` }),
          h('b', { text: 'Fable 5.2 临近到期顾问' }),
          h('span', { class: 'inf-comp-tag', text: statusBadge })
        ),
        h('div', { class: 'inf-comp-meta', style: 'margin-top:4px' },
          h('span', { text: winTxt })
        ),
        sugs.length
          ? h('div', { style: 'margin-top:6px;display:flex;flex-direction:column;gap:5px' },
              ...sugs.map((s) => h('div', { style: 'border:1px solid var(--border);padding:4px 6px;background:var(--bg2,transparent)' },
                h('div', { style: 'display:flex;align-items:center;gap:6px;flex-wrap:wrap' },
                  h('span', { class: 'inf-comp-tag', text: s.source || '难题' }),
                  s.projectName ? h('span', { class: 'inf-comp-muted', text: s.projectName }) : null,
                  h('button', {
                    class: 'btn go',
                    type: 'button',
                    style: 'margin-left:auto;padding:1px 6px;font-size:10px',
                    text: '派 Fable 顾问',
                    onclick: async () => {
                      if (s.machine && s.cwd) {
                        if (!(await confirmBox(`确定在 ${s.machine} (${s.cwd}) 启动只读 Fable 5.2 顾问分析「${s.title}」吗？`))) return;
                        const r = await net.post('/api/mesh/fable-advice/launch', {
                          projectId: s.projectId || '',
                          machine: s.machine,
                          cwd: s.cwd,
                          title: s.title,
                          advisorPrompt: s.advisorPrompt,
                        });
                        if (r && r.ok) say(`已在 ${s.machine} 启动 Fable 5.2 顾问`);
                        else say((r && r.msg) || '启动失败');
                      } else {
                        openFableLaunchDialog(s, sortedMachines);
                      }
                    },
                  })
                ),
                h('div', { style: 'margin-top:3px;font-weight:bold;font-size:11px', text: s.title }),
                s.detail ? h('div', { class: 'inf-comp-muted', style: 'margin-top:2px', text: s.detail.slice(0, 140) }) : null
              ))
            )
          : h('div', {
              class: 'inf-comp-muted',
              style: 'margin-top:4px',
              text: adv && (adv.due || adv.preview)
                ? '当前未从项目阻塞项或重要计划中筛出高难度待攻克难题。'
                : '当 Devin 7天/1天额度余量 >= 50% 且临近重置时自动推荐 Top 3 难题；也可点右上角“预览推荐难题”手动查看。',
            })
      )
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
        if (p.id === 'sugon' && meta) {
          const modeLabel = meta.mode === 'openapi' ? 'OpenAPI v2' : 'SSH + Slurm';
          const profs = Array.isArray(meta.profiles) ? meta.profiles : [];
          const onlineCnt = meta.onlineCount != null ? meta.onlineCount : profs.filter((x) => x.available).length;
          const totalCnt = meta.totalCount != null ? meta.totalCount : profs.length;
          const rfCnt = profs.filter((x) => x.hasRayfile).length;
          const expKeys = Array.isArray(meta.expiringKeys) ? meta.expiringKeys : [];
          const parts = Array.isArray(meta.partitions) ? meta.partitions : [];
          const partTxt = parts.length
            ? parts.slice(0, 4).map((pt) => (typeof pt === 'string' ? pt : `${pt.name}(${pt.idleNodes || 0}/${pt.totalNodes || 0})`)).join(', ')
            : (meta.defaultPartition || '—');
          return h('div', { class: 'inf-comp-provider' },
            h('div', { style: 'display:flex;align-items:center;gap:6px;flex-wrap:wrap' },
              h('span', { class: `inf-dot ${p.status === 'active' ? 'on' : ''}` }),
              h('b', { text: p.name }),
              h('span', { class: 'inf-comp-tag', text: `${statusTxt} · ${modeLabel}${totalCnt > 1 ? ` · ${onlineCnt}/${totalCnt} 入口` : ''}` }),
              rfCnt > 0 ? h('span', { class: 'inf-comp-tag', text: `快传 ${rfCnt}` }) : null,
              p.status === 'active'
                ? h('button', {
                    class: 'btn',
                    type: 'button',
                    style: 'margin-left:auto;padding:1px 6px;font-size:10px',
                    text: '投曙光',
                    onclick: () => openSubmitDialog('', { providerType: 'sugon' }),
                  })
                : null
            ),
            h('div', { class: 'inf-comp-meta', style: 'margin-top:4px' },
              h('span', { text: `网关机: ${meta.machine || '—'}` }),
              h('span', { text: `默认分区: ${partTxt}` }),
              h('span', { text: `在途作业: ${meta.runningJobs || 0} 运行 / ${meta.queuedJobs || 0} 排队` }),
              meta.at ? h('span', { class: 'inf-comp-muted', text: `更新于 ${ago(meta.at)}` }) : null
            ),
            expKeys.length
              ? h('div', {
                  class: 'inf-comp-muted',
                  style: 'color:#b45309;margin-top:3px',
                  text: `密钥临近到期: ${expKeys.map((k) => `${k.label || k.id} (${k.keyExpireAt})`).join(', ')}`,
                })
              : null,
            meta.error ? h('div', { class: 'inf-comp-muted', text: `状态异常: ${meta.error}` }) : null
          );
        }
        return h('div', { class: 'inf-comp-provider' },
          h('b', { text: p.name }),
          h('span', { class: 'inf-comp-tag', text: statusTxt }),
          h('div', { class: 'inf-comp-muted', text: p.note || '' })
        );
      }),
      renderFableAdvisorCard(sortedMachines)
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
