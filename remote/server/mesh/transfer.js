// Cross-machine file transfer & sneakernet (manual disk copy) handoff state machine for AmeMesh.
'use strict';
const crypto = require('crypto');
const path = require('path');
const {
  AUTO_FILE_LIMIT,
  MAX_TRANSFERS,
  cleanStr,
  idGen,
  crc32Of,
  normFolderPath,
  formatEnvelope,
} = require('./helpers');

function createMeshTransfer(ctx) {
  const {
    data,
    machines,
    save,
    recordEvent,
    checkWorkspaceAccess,
    enrichProject,
  } = ctx;

  const activeTransfers = new Map(); // readRid | upRid -> transfer state

  function agentFileSock(machineName, needUpload = false) {
    const m = machines && machines.get(machineName);
    if (!m || !m.online || !m.files || !m.sockets || !m.sockets.size) return null;
    const open = [...m.sockets].reverse().filter((s) => s && s.readyState === 1);
    if (!open.length) return null;
    if (needUpload) {
      const hasUpload = m.upload || open.some((s) => s.uploadAllowed === true);
      if (!hasUpload) return null;
      return open.find((s) => s.uploadAllowed === true && s.filesAllowed !== false) ||
        open.find((s) => s.filesAllowed !== false) ||
        open[0];
    }
    return open.find((s) => s.filesAllowed === true) || open.find((s) => s.filesAllowed !== false) || open[0];
  }

  function sendAgentFs(machineName, needUpload, payload) {
    const sock = agentFileSock(machineName, needUpload);
    if (!sock) return false;
    try {
      sock.send(JSON.stringify(payload));
      return true;
    } catch {
      return false;
    }
  }

  function cleanupTransfer(st) {
    if (st.done) return;
    st.done = true;
    clearTimeout(st.timer);
    activeTransfers.delete(st.readRid);
    activeTransfers.delete(st.upRid);
  }

  function failTransfer(st, reason) {
    if (st.done) return;
    cleanupTransfer(st);
    st.item.status = 'pending';
    st.item.error = cleanStr(reason || '传输失败', 300);
    st.item.updatedAt = Date.now();
    save();
  }

  function touchTransfer(st) {
    clearTimeout(st.timer);
    st.timer = setTimeout(() => {
      if (st.done) return;
      sendAgentFs(st.fromMachine, false, { t: 'fs-cancel', rid: st.readRid });
      sendAgentFs(st.toMachine, true, { t: 'fs-cancel', rid: st.upRid, drop: false });
      failTransfer(st, '跨机传输超时（60秒无响应）');
    }, 60e3);
    if (st.timer.unref) st.timer.unref();
  }

  function processTransferChunk(st, i, buf) {
    const off = st.sentOff;
    st.sentOff += buf.length;
    st.crc = crc32Of(buf, st.crc);
    const endOff = off + buf.length;
    if (endOff <= st.have) {
      sendAgentFs(st.fromMachine, false, { t: 'fs-ack', rid: st.readRid, i });
      return true;
    }
    const sendOff = off < st.have ? st.have : off;
    const slice = off < st.have ? buf.subarray(st.have - off) : buf;
    st.awaitingAck.push({ i, endOff });
    const ok = sendAgentFs(st.toMachine, true, {
      t: 'fs-up',
      rid: st.upRid,
      off: sendOff,
      data: slice.toString('base64'),
    });
    if (!ok) {
      sendAgentFs(st.fromMachine, false, { t: 'fs-cancel', rid: st.readRid });
      failTransfer(st, '向目标机器发送数据块失败');
      return false;
    }
    return true;
  }

  function finishTransferReadIfReady(st) {
    if (st.done || st.upEndSent || !st.readEnded || st.phase !== 'streaming') return;
    st.upEndSent = true;
    st.phase = 'finishing';
    const ok = sendAgentFs(st.toMachine, true, { t: 'fs-up-end', rid: st.upRid, crc: st.crc >>> 0 });
    if (!ok) {
      failTransfer(st, '向目标机器发送结束校验请求失败');
    }
  }

  function startAutoTransfer(proj, item) {
    const readRid = 'mfs-r-' + crypto.randomBytes(8).toString('hex');
    const upRid = 'mfs-u-' + crypto.randomBytes(8).toString('hex');
    const remotePath = /^[A-Za-z]:[\\/]/.test(item.toPath) || /^\\\\/.test(item.toPath) ? path.win32 : path.posix;
    const st = {
      proj,
      item,
      readRid,
      upRid,
      fromMachine: item.fromMachine,
      toMachine: item.toMachine,
      dstDir: remotePath.dirname(item.toPath),
      dstName: remotePath.basename(item.toPath),
      phase: 'reading',
      size: 0,
      mtime: 0,
      have: 0,
      sentOff: 0,
      crc: 0,
      pendingChunks: [],
      awaitingAck: [],
      readEnded: false,
      upEndSent: false,
      timer: null,
      done: false,
    };
    activeTransfers.set(readRid, st);
    activeTransfers.set(upRid, st);
    touchTransfer(st);
    const ok = sendAgentFs(st.fromMachine, false, {
      t: 'fs',
      rid: readRid,
      op: 'read',
      path: item.fromPath,
      dl: true,
    });
    if (!ok) {
      failTransfer(st, '向源机器发送读取请求失败');
    }
  }

  function fromAgentFs(machineObj, d) {
    if (!d || typeof d.rid !== 'string' || !d.rid.startsWith('mfs-')) return false;
    const st = activeTransfers.get(d.rid);
    if (!st || st.done) return true;
    const mName = typeof machineObj === 'string' ? machineObj : (machineObj && machineObj.name);
    if (d.rid === st.readRid && mName && mName !== st.fromMachine) return true;
    if (d.rid === st.upRid && mName && mName !== st.toMachine) return true;

    touchTransfer(st);

    if (d.rid === st.readRid) {
      if (d.t === 'fs-res') {
        if (!d.ok) {
          failTransfer(st, '读取源文件失败：' + (d.msg || ''));
          return true;
        }
        const sz = Number(d.size) || 0;
        if (sz >= AUTO_FILE_LIMIT) {
          sendAgentFs(st.fromMachine, false, { t: 'fs-cancel', rid: st.readRid });
          cleanupTransfer(st);
          st.item.size = sz;
          st.item.mode = 'manual_disk';
          st.item.status = 'pending';
          st.item.error = '';
          st.item.note = (st.item.note ? st.item.note + '；' : '') + '实际文件 >= 50MB，已自动转为移动硬盘人工摆渡';
          st.item.updatedAt = Date.now();
          save();
          return true;
        }
        st.size = sz;
        st.mtime = Number.isFinite(d.mtime) ? d.mtime : 0;
        st.item.size = sz;
        st.item.updatedAt = Date.now();
        st.phase = 'up_opening';
        save();
        const ok = sendAgentFs(st.toMachine, true, {
          t: 'fs',
          rid: st.upRid,
          op: 'up-open',
          path: st.dstDir,
          name: st.dstName,
          size: sz,
          mtime: st.mtime,
          overwrite: true,
        });
        if (!ok) {
          sendAgentFs(st.fromMachine, false, { t: 'fs-cancel', rid: st.readRid });
          failTransfer(st, '向目标机器发送写入请求失败');
        }
        return true;
      }
      if (d.t === 'fs-chunk') {
        const buf = typeof d.data === 'string' ? Buffer.from(d.data, 'base64') : Buffer.alloc(0);
        if (st.phase === 'up_opening' || st.phase === 'reading') {
          if (st.pendingChunks.length < 16) st.pendingChunks.push({ i: d.i, buf });
        } else if (st.phase === 'streaming') {
          processTransferChunk(st, d.i, buf);
        }
        return true;
      }
      if (d.t === 'fs-end') {
        st.readEnded = true;
        finishTransferReadIfReady(st);
        return true;
      }
      return true;
    }

    if (d.rid === st.upRid) {
      if (d.t === 'fs-res') {
        if (!d.ok) {
          sendAgentFs(st.fromMachine, false, { t: 'fs-cancel', rid: st.readRid });
          failTransfer(st, '目标写入失败：' + (d.msg || ''));
          return true;
        }
        st.have = Number.isSafeInteger(d.have) && d.have > 0 ? d.have : 0;
        st.phase = 'streaming';
        const buffered = st.pendingChunks.splice(0, st.pendingChunks.length);
        for (const c of buffered) {
          if (!processTransferChunk(st, c.i, c.buf)) return true;
        }
        finishTransferReadIfReady(st);
        return true;
      }
      if (d.t === 'fs-up-ack') {
        if (d.checking) return true;
        while (
          st.awaitingAck.length > 0 &&
          (typeof d.have !== 'number' || st.awaitingAck[0].endOff <= d.have)
        ) {
          const acked = st.awaitingAck.shift();
          sendAgentFs(st.fromMachine, false, { t: 'fs-ack', rid: st.readRid, i: acked.i });
        }
        return true;
      }
      if (d.t === 'fs-up-done') {
        if (d.ok) {
          cleanupTransfer(st);
          st.item.status = 'completed';
          st.item.error = '';
          st.item.updatedAt = Date.now();
          recordEvent(st.proj, {
            source: 'transfer',
            kind: 'auto_done',
            machine: st.item.toMachine,
            summary: '跨机文件自动传输完成：' + st.dstName,
          });
          const targetNode = (st.item.notifyNodeId && st.proj.nodes.find((n) => n.id === st.item.notifyNodeId)) ||
            st.proj.nodes.find((n) => n.machine === st.item.toMachine) ||
            st.proj.nodes.find((n) => n.role === 'master');
          if (targetNode) {
            const msg = formatEnvelope({
              project: st.proj,
              toNode: targetNode,
              type: 'handoff_ready',
              text: `跨机文件已自动传输就位：源 [${st.item.fromMachine}:${st.item.fromPath}] -> 目标 [${st.item.toMachine}:${d.path || st.item.toPath}]。请直接读取该路径继续后续任务。`,
            });
            ctx.deliverToNode(st.proj, targetNode, msg).catch(() => {});
          }
        } else {
          failTransfer(st, d.msg || '传输校验失败');
        }
        return true;
      }
    }
    return true;
  }

  function requestTransfer({
    projectId,
    fromMachine,
    fromPath,
    toMachine,
    toPath,
    size = 0,
    mode = '',
    notifyNodeId = '',
    note = '',
  }) {
    const proj = projectId ? data.projects.find((x) => x.id === projectId) : data.projects[0];
    if (!proj) return { ok: false, msg: '请先创建或指定协同项目' };
    const cleanFromM = cleanStr(fromMachine, 60), cleanFromP = cleanStr(fromPath, 600);
    const cleanToM = cleanStr(toMachine, 60), cleanToP = cleanStr(toPath, 600);
    if (!cleanFromM || !cleanFromP || !cleanToM || !cleanToP) return { ok: false, msg: '源路径和目标路径不能为空' };
    if (cleanFromM === cleanToM && normFolderPath(cleanFromP) === normFolderPath(cleanToP)) {
      return { ok: false, msg: '源路径与目标路径完全相同，无需传输' };
    }

    const remotePath = /^[A-Za-z]:[\\/]/.test(cleanToP) || /^\\\\/.test(cleanToP) ? path.win32 : path.posix;
    const dstCheck = checkWorkspaceAccess(proj, cleanToM, remotePath.dirname(cleanToP), true);
    if (!dstCheck.ok) return dstCheck;

    const numSize = +size || 0;
    const finalMode = mode === 'manual_disk' || numSize >= AUTO_FILE_LIMIT ? 'manual_disk' : 'auto';
    const item = {
      id: idGen('xfer'),
      fromMachine: cleanFromM,
      fromPath: cleanFromP,
      toMachine: cleanToM,
      toPath: cleanToP,
      size: numSize,
      mode: finalMode,
      status: 'pending',
      notifyNodeId: cleanStr(notifyNodeId, 40),
      note: cleanStr(note, 500),
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    proj.transfers = proj.transfers || [];
    if (proj.transfers.length >= MAX_TRANSFERS) proj.transfers.pop();
    proj.transfers.unshift(item);

    if (finalMode === 'auto') {
      const fromSock = agentFileSock(cleanFromM, false);
      const toSock = agentFileSock(cleanToM, true);
      if (fromSock && toSock) {
        item.status = 'transferring';
        item.error = '';
        save();
        startAutoTransfer(proj, item);
        return { ok: true, transfer: item, project: enrichProject(proj) };
      }
      const fromM = machines && machines.get(cleanFromM);
      const toM = machines && machines.get(cleanToM);
      const toHasUpload = toM && (toM.upload || [...(toM.sockets || [])].some((s) => s && s.readyState === 1 && s.uploadAllowed === true));
      if (!fromM || !fromM.online) item.error = `源机器「${cleanFromM}」不在线`;
      else if (!fromM.files) item.error = `源机器「${cleanFromM}」未开启文件服务`;
      else if (!fromSock) item.error = `源机器「${cleanFromM}」无可用文件连接`;
      else if (!toM || !toM.online) item.error = `目标机器「${cleanToM}」不在线`;
      else if (!toM.files) item.error = `目标机器「${cleanToM}」未开启文件服务`;
      else if (!toHasUpload) item.error = `目标机器「${cleanToM}」未开启文件上传`;
      else item.error = `目标机器「${cleanToM}」无可用上传连接`;
    }

    save();
    return { ok: true, transfer: item, project: enrichProject(proj) };
  }

  async function confirmTransfer(projectId, transferId, { newToPath = '', wake = true } = {}) {
    const proj = data.projects.find((x) => x.id === projectId);
    if (!proj) return { ok: false, msg: '找不到该项目' };
    const xfer = (proj.transfers || []).find((t) => t.id === transferId);
    if (!xfer) return { ok: false, msg: '找不到该文件传输记录' };
    for (const st of activeTransfers.values()) {
      if (st.item === xfer && !st.done) {
        sendAgentFs(st.fromMachine, false, { t: 'fs-cancel', rid: st.readRid });
        sendAgentFs(st.toMachine, true, { t: 'fs-cancel', rid: st.upRid, drop: true });
        cleanupTransfer(st);
      }
    }
    if (typeof newToPath === 'string' && newToPath.trim()) {
      xfer.toPath = cleanStr(newToPath, 600);
    }
    xfer.status = 'completed';
    xfer.updatedAt = Date.now();
    save();

    const targetNode = (xfer.notifyNodeId && proj.nodes.find((n) => n.id === xfer.notifyNodeId)) ||
      proj.nodes.find((n) => n.machine === xfer.toMachine) ||
      proj.nodes.find((n) => n.role === 'master');

    if (wake && targetNode) {
      const msg = formatEnvelope({
        project: proj,
        toNode: targetNode,
        type: 'handoff_ready',
        text: `超大文件已通过人工硬盘拷贝就位：源 [${xfer.fromMachine}:${xfer.fromPath}] -> 目标 [${xfer.toMachine}:${xfer.toPath}]。请直接读取该路径继续后续任务。`,
      });
      await ctx.deliverToNode(proj, targetNode, msg, { forceWake: true });
    }
    return { ok: true, transfer: xfer, project: enrichProject(proj) };
  }

  return {
    fromAgentFs,
    requestTransfer,
    confirmTransfer,
  };
}

module.exports = { createMeshTransfer };
