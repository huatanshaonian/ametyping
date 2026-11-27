// Shared constants and pure helpers for the AmeMesh Projects app (proj-*.js).
import { h } from '../util.js';

export const ROLE_NAMES = {
  master: 'Master 主控',
  worker: 'Worker 执行',
  peer: 'Cowork 平级',
  verifier: 'Verifier 验收',
};

export const REVIEW_NAMES = {
  running: ['run', '执行中'],
  waiting_review: ['wait', '待检视 (Review Gate)'],
  approved: ['done', '已批准'],
  done: ['done', '已完成'],
  blocked: ['err', '受阻'],
};

export const TASK_STATUSES = [
  ['pending', '待办'],
  ['in_progress', '进行中'],
  ['review', '待审'],
  ['done', '完成'],
  ['blocked', '受阻'],
];

export const BOARD_KINDS = [
  ['all', '全部'],
  ['post', '帖子'],
  ['brief', '契约'],
  ['report', '汇报'],
  ['task', '任务'],
  ['watchdog', '看门狗'],
  ['event', '事件'],
];

export const BOARD_KIND_LABELS = {
  brief: '契约',
  post: '帖子',
  report: '汇报',
  task: '任务',
  watchdog: '看门狗',
  event: '事件',
  control: '控制',
};

export const TOPO_EDGE_TYPE_NAMES = {
  'master-worker': '主从委派',
  cowork: '平级协同',
  handoff: '交接',
};

export function renderPostBody(text, onJumpSeq) {
  const body = h('div', { class: 'pm-post-body' });
  const src = String(text || '');
  const re = /(@[A-Za-z0-9_\u4e00-\u9fa5-]+(?:\.[A-Za-z0-9_\u4e00-\u9fa5-]+)*|#\d+(?![A-Za-z0-9_]))/g;
  let last = 0;
  let m;
  while ((m = re.exec(src)) !== null) {
    const idx = m.index;
    const tok = m[0];
    if (tok.startsWith('@') && idx > 0 && /[A-Za-z0-9_]/.test(src[idx - 1])) continue;
    if (idx > last) body.append(document.createTextNode(src.slice(last, idx)));
    if (tok.startsWith('@')) {
      body.append(h('span', { class: 'pm-mention', text: tok }));
    } else {
      const seqNum = tok.slice(1);
      body.append(h('button', {
        class: 'pm-ref-pill',
        type: 'button',
        text: tok,
        title: `跳转到 #${seqNum}`,
        onclick: () => onJumpSeq(seqNum),
      }));
    }
    last = idx + tok.length;
  }
  if (last < src.length) body.append(document.createTextNode(src.slice(last)));
  return body;
}

export function formatAuditMessage(audit) {
  if (!audit) return '';
  const parts = [];
  const oob = audit.outOfBounds || audit.outsideFiles || audit.outside || audit.violations || audit.unexpectedFiles;
  if (Array.isArray(oob) && oob.length) parts.push(`越界改动文件: ${oob.join(', ')}`);
  if (audit.emptyChange || audit.empty || audit.noChanges || audit.changedCount === 0) parts.push('未检测到实际代码改动（空变更）');
  if (audit.reason || audit.msg || audit.summary) parts.push(String(audit.reason || audit.msg || audit.summary));
  return parts.length ? parts.join('；') : 'Git 工作区审计未通过，请核查改动范围';
}

export function matchNodeByToken(nodes, tok) {
  const t = String(tok || '').trim().toLowerCase();
  if (!t) return null;
  return nodes.find((n) => {
    const a = String(n.alias || '').trim().toLowerCase();
    const l = String(n.label || '').trim().toLowerCase();
    const id = String(n.id || '').trim().toLowerCase();
    const r = String(n.role || '').trim().toLowerCase();
    return (a && a === t) || (l && l === t) || (id && id === t) || (r && r === t);
  }) || null;
}

export function extractMentionTokens(entry) {
  if (Array.isArray(entry.mentions) && entry.mentions.length) {
    return { tokens: entry.mentions, mentionAll: !!entry.mentionAll };
  }
  const src = String(entry.text || '');
  const re = /@([A-Za-z0-9_\u4e00-\u9fa5-]+)/g;
  const tokens = [];
  let mentionAll = !!entry.mentionAll;
  let m;
  while ((m = re.exec(src)) !== null) {
    const tok = m[1];
    if (!tok) continue;
    if (tok.toLowerCase() === 'all') mentionAll = true;
    else tokens.push(tok);
  }
  return { tokens, mentionAll };
}

export function roleOriginOf(r) {
  const src = String((r && (r.source || r.origin || r.status)) || '').toLowerCase();
  if ((r && (r.overridden || r.isOverridden)) || src === 'overridden') return 'overridden';
  if ((r && (r.builtin || r.isBuiltin)) || src === 'builtin') return 'builtin';
  return 'custom';
}
