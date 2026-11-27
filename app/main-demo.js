'use strict';
// Scripted self-test & visual capture harness (AME_DEMO*) for the AmeTyping Electron main process.

const fs = require('fs');
const path = require('path');

function createDemoRunner({
  app,
  screen,
  ipcMain,
  getWin,
  getBubbleWin,
  settings,
  cfg,
  VX,
  setScale,
  setPanelMode,
  onClaudeEvent,
  folded,
  save,
}) {
  return function runDemo(outDir) {
    const win = getWin();
    const bubbleWin = getBubbleWin();
    if (process.env.AME_FACING) {
      settings.facing = process.env.AME_FACING;
      win.webContents.send('config', cfg());
    }
    fs.mkdirSync(outDir, { recursive: true });
    const shots = [['F', 33], ['J', 36], ['Esc', 1], ['Space', 57], ['Right', 57421], ['Enter', 28], ['Knob', 57392], ['Del', 3667]];
    const send = (code, down) => win.webContents.send('key', { code, down });

    win.webContents.once('did-finish-load', async () => {
      const wait = (ms) => new Promise((r) => setTimeout(r, ms));
      await wait(800);

      if (process.env.AME_DEMO_PANEL) {
        const shot = async (n) => {
          await wait(500);
          fs.writeFileSync(path.join(outDir, `panel_${n}.png`), (await bubbleWin.webContents.capturePage()).toPNG());
          console.log(n, JSON.stringify(bubbleWin.getBounds()));
        };
        const rect = (id) => bubbleWin.webContents.executeJavaScript(`(() => { const r = document.getElementById('${id}').getBoundingClientRect(); return [Math.round(r.x + r.width / 2), Math.round(r.y + r.height / 2)]; })()`);
        const click = async ([x, y], n = 1) => {
          for (let i = 0; i < n; i++) {
            for (const type of ['mouseDown', 'mouseUp']) bubbleWin.webContents.sendInputEvent({ type, x, y, button: 'left', clickCount: i + 1 });
            await wait(120);
          }
        };
        setPanelMode('popup');
        const ev = (session, project, type, text) => onClaudeEvent(type, { session, project, text });
        ev('a', 'ame-typing', 'message', '给进度面板加折叠按钮'); ev('a', 'ame-typing', 'reading', '读 main.js'); ev('a', 'ame-typing', 'thinking', '想想 placeBubble 怎么改');
        ev('b', 'medstat', 'message', '跑 Table 1'); ev('b', 'medstat', 'waiting', '要不要覆盖旧结果？');
        await shot('1_expanded');
        await click(await rect('fold')); await shot('2_collapsed_by_button');
        ev('a', 'ame-typing', 'reading', '读 bubble.js'); await shot('3_collapsed_new_activity');
        await click(await rect('fold')); await shot('4_expanded_by_button');
        await click(await rect('who'), 2); await shot('5_collapsed_by_dblclick');
        await click(await rect('who'), 2); await shot('6_expanded_by_dblclick');
        return app.quit();
      }

      if (process.env.AME_DEMO_PCHAN) {
        const js = (s) => win.webContents.executeJavaScript(s);
        const shot = async (n, w = win) => {
          await wait(450);
          fs.writeFileSync(path.join(outDir, `pchan_${n}.png`), (await w.webContents.capturePage()).toPNG());
          console.log(n, JSON.stringify(bubbleWin.getBounds()), bubbleWin.isVisible());
        };
        const ev = (session, project, type, text) => onClaudeEvent(type, { session, project, text });
        await js('window.__noPersist = true; window.__fakeHour = 14; mouseFrozen = true; mood.blinkAt = 1e12; act.next = 1e12; pch.blinkAt = 1e12;');
        setScale(0.7, false); win.setPosition(20, 20); await wait(600);
        setPanelMode('pchan'); await shot('1_sleep');
        ev('a', 'ame-typing', 'message', 'demo one'); ev('a', 'ame-typing', 'reading', 'demo two');
        await wait(300); bubbleWin.webContents.send('bubble-collapsed', false); await wait(300); bubbleWin.webContents.send('bubble-collapsed', true); await wait(300);
        await shot('2_idle');
        await js('pch.blinkAt = 1e12; pch.blinkUntil = now() + 3000;'); await wait(60); await shot('2b_blink');
        await js('pch.blinkAt = 1e12; pch.blinkUntil = 0;');
        ev('b', 'medstat', 'message', 'Table 1'); ev('b', 'medstat', 'waiting', 'overwrite?'); ev('a', 'ame-typing', 'thinking', 'more');
        await wait(400);
        for (const i of [0, 1, 2]) { await shot(`3_alert_${i}`); await wait(330); }
        const c = await js(`(() => { const r = pchRect(); return [Math.round((r.x + r.w / 2 - ${VX}) * scale), Math.round((r.y + r.h * 0.6) * scale), pchState(), panel.unread, panel.n]; })()`);
        console.log('pchan click point', c);
        const mv = (x, y) => win.webContents.sendInputEvent({ type: 'mouseMove', x, y });
        mv(c[0], c[1]); await wait(150); mv(c[0] + 1, c[1]); await wait(400); await shot('4_hover');
        for (const type of ['mouseDown', 'mouseUp']) { win.webContents.sendInputEvent({ type, x: c[0], y: c[1], button: 'left', clickCount: 1 }); await wait(100); }
        await wait(600);
        console.log('after click: folded', folded(), 'visible', bubbleWin.isVisible());
        await shot('5_expanded'); await shot('5_expanded_panel', bubbleWin);
        return app.quit();
      }

      if (process.env.AME_DEMO_DRAG) {
        ipcMain.emit('gesture', null, 'drag-start');
        const log = [];
        const t0 = Date.now();
        while (Date.now() - t0 < 2600) {
          const p = screen.getCursorScreenPoint(), b = win.getBounds();
          log.push([Date.now() - t0, p.x - b.x, p.y - b.y, b.width, b.height].join(' '));
          await wait(40);
        }
        ipcMain.emit('gesture', null, 'drag-end');
        fs.writeFileSync(path.join(outDir, 'drag.log'), log.join('\n'));
        return app.quit();
      }

      if (process.env.AME_DEMO_KB) {
        setScale(1);
        for (const f of ['her', 'you']) {
          settings.facing = f; win.webContents.send('config', cfg());
          await win.webContents.executeJavaScript('kbOnly = true; showLegends = false; kbCache = null;');
          await wait(900);
          const img = await win.webContents.capturePage();
          fs.writeFileSync(path.join(outDir, `kb_${f}.png`), img.toPNG());
        }
        settings.facing = 'her'; settings.scale = 0.36; save();
        return app.quit();
      }

      if (process.env.AME_DEMO_POP) {
        const js = (s) => win.webContents.executeJavaScript(s), log = [];
        await js('window.__noPersist = true; window.__fakeHour = 14; mouseFrozen = true; mood.blinkAt = 1e12; act.next = 1e12;');
        await wait(700);
        const seq = ['surprised', 'happy', 'teary', 'angry', 'sparkle', 'half', 'neutral', 'BLINK', 'happy', 'sleep', 'neutral'];
        for (let n = 0; n < seq.length; n++) {
          const f = seq[n];
          await js('window.__popU = -1;');
          const pre = await win.webContents.capturePage();
          fs.writeFileSync(path.join(outDir, `pop_${n}_${f}_pre.png`), pre.toPNG());
          if (f === 'BLINK') await js('mood.blinkAt = 0;');
          else if (f === 'sleep') await js('mood.tempUntil = 0; mood.lastKeyT = performance.now() - 300000; mood.blinkAt = 1e12;');
          else if (f === 'neutral') await js('mood.tempUntil = 0; mood.sleeping = false; mood.lastKeyT = performance.now(); mood.blinkAt = 1e12;');
          else await js(`mood.lastKeyT = performance.now(); setTemp('${f}', 60000); mood.blinkAt = 1e12;`);
          await wait(60);
          for (let i = 0; i < 16; i++) {
            await js(`window.__popU = ${i / 15}`); await wait(110);
            const img = await win.webContents.capturePage();
            log.push(`${n} ${f} ${i} u=${(i / 15).toFixed(2)} ` + await js('[mood.face, mood.open, Math.round(facePop.t0)].join(" ")'));
            fs.writeFileSync(path.join(outDir, `pop_${n}_${f}_${String(i).padStart(2, '0')}.png`), img.toPNG());
          }
          await js('window.__popU = undefined;');
          if (f === 'BLINK') await js('mood.blinkAt = 1e12;');
          await wait(600);
        }
        fs.writeFileSync(path.join(outDir, 'pop_log.txt'), log.join('\n'));
        return app.quit();
      }

      if (process.env.AME_DEMO_PAT) {
        await win.webContents.executeJavaScript('mood.lastKeyT -= 10000; mood.blinkAt = 1e12; mouseFrozen = true;');
        for (let f = 0; f < 40; f++) {
          const x = 724 + Math.sin(f * 0.9) * 120;
          if (f < 26) await win.webContents.executeJavaScript(`mouse.x = ${x}; mouse.y = 250; mouse.seen = true; detectPat({ x: ${x}, y: 250 });`);
          else if (f === 26) await win.webContents.executeJavaScript('carry.vx = 380; carry.vy = -150;');
          const img = await win.webContents.capturePage();
          fs.writeFileSync(path.join(outDir, `p_${String(f).padStart(2, '0')}.png`), img.toPNG());
          await wait(50);
        }
        return app.quit();
      }

      if (process.env.AME_DEMO_KANGEL_FACES) {
        const js = (s) => win.webContents.executeJavaScript(s);
        await js('window.__noPersist = true; window.__fakeHour = 14; mouseFrozen = true; mood.blinkAt = 1e12; act.next = 1e12;');
        await js('KA.ready && setKForm(true, 0, true)'); await wait(800);
        for (const f of 'blink,half,focus,happy,annoyed,surprised,yandere,sleep,wink,smug,pout,teary,blush,angry,sparkle,dizzy,deadpan,sweat,yawn,sip,stretch'.split(',')) {
          await js(`mood.sleeping = false; mood.lastKeyT = performance.now(); setTemp('${f}', 60000); mood.blinkAt = 1e12;`); await wait(700);
          fs.writeFileSync(path.join(outDir, `k_face_${f}.png`), (await win.webContents.capturePage()).toPNG());
        }
        return app.quit();
      }

      if (process.env.AME_DEMO_KANGEL) {
        const js = (s) => win.webContents.executeJavaScript(s);
        const shot = async (name) => fs.writeFileSync(path.join(outDir, `k_${name}.png`), (await win.webContents.capturePage()).toPNG());
        const log = [];
        const st = () => js("[KA.ready, KA.on, mood.face, Math.round(now() - KA.flashT), !!RIG.gaze, !!RIG.frontHair, Object.keys(RIG.faces).length].join(' ')");
        const typeWord = async () => { for (const c of [37, 30, 49, 34, 18, 38]) { send(c, true); await wait(40); send(c, false); await wait(60); } };
        const flash = async (tag, n) => { for (let i = 0; i < n; i++) { await shot(`${tag}_${String(i).padStart(2, '0')}`); log.push(`${tag} ${i} ${await st()}`); await wait(25); } };
        await js('window.__noPersist = true; window.__fakeHour = 14; mouseFrozen = true; mood.blinkAt = 1e12; act.next = 1e12; window.__id0 = [img.head, img.torso, img.tailL, RIG.faces, RIG.gaze, RIG.frontHair, RIG.faceTop];');
        await wait(400); await shot('a_before'); log.push('before ' + await st());
        await typeWord(); await flash('b_flash', 14);
        await wait(1900); await shot('c_kangel'); log.push('settled ' + await st());
        for (const f of ['blink', 'happy', 'wink', 'surprised', 'annoyed', 'sleep', 'dizzy', 'sparkle', 'half']) {
          await js(`setTemp('${f}', 60000); mood.blinkAt = 1e12;`); await wait(250); await shot(`d_face_${f}`);
        }
        await js('mood.tempUntil = 0; mood.lastKeyT = performance.now();');
        await typeWord(); await flash('e_back', 10);
        await wait(1900); await shot('f_ame_after'); log.push('back ' + await st());
        log.push('ame identity ' + await js('[img.head, img.torso, img.tailL, RIG.faces, RIG.gaze, RIG.frontHair, RIG.faceTop].every((v, i) => v === window.__id0[i])'));
        await typeWord(); await wait(1500); log.push('typed again ' + await st());
        await js('KA.until = performance.now() + 200;'); await wait(1900); log.push('after timed expiry ' + await st()); await shot('g_expired');
        settings.kangel = true; win.webContents.send('config', cfg()); await wait(1500); log.push('lock on ' + await st());
        await typeWord(); await wait(1200); log.push('lock + typed ' + await st());
        settings.kangel = false; win.webContents.send('config', cfg()); await wait(1500); log.push('lock off ' + await st());
        fs.writeFileSync(path.join(outDir, 'k_log.txt'), log.join('\n'));
        return app.quit();
      }

      if (process.env.AME_DEMO_TIME) {
        const js = (s) => win.webContents.executeJavaScript(s);
        const shot = async (name) => fs.writeFileSync(path.join(outDir, `t_${name}.png`), (await win.webContents.capturePage()).toPNG());
        await js('window.__noPersist = true; mouseFrozen = true; mood.blinkAt = 1e12; act.next = 1e12;');
        await js('window.__fakeHour = 14; mood.lastKeyT = performance.now() - 10000;');
        await wait(500); await shot('day_idle');
        await js('window.__fakeHour = 1; mood.lastKeyT = performance.now() - 10000;');
        await wait(500); await shot('late_idle');
        await js('window.__fakeHour = 3; mood.lastKeyT = performance.now() - 10000;');
        await wait(500); await shot('late3_idle');
        await js('window.__fakeHour = 1; mood.lastKeyT = performance.now() - 100000;');
        await wait(500); await shot('late_sleep');
        await js('window.__fakeHour = undefined; mood.lastKeyT = performance.now(); mood.sleeping = false; mood.tempUntil = 0;');
        for (let i = 0; i < 6; i++) {
          await js(`fakeSession(95); work.nextNag = 1e15; showNag(NAG_LINES[${i}]); nag.t0 = performance.now() - 300; mood.lastKeyT = performance.now();`);
          await wait(120); await shot(`nag_${i}`);
        }
        await js('mood.tempUntil = 0; nag.t0 = -1e9; fakeSession(89.9); work.nextNag = performance.now() + 500;');
        await wait(1000); await shot('nag_auto');
        await js('nag.t0 = -1e9; mood.tempUntil = 0; lastKeyT = performance.now() - 5000; mood.lastKeyT = performance.now() - 5000; lastActiveWall = Date.now() - 5 * 3600e3;');
        send(33, true); await wait(1000); await shot('welcome'); send(33, false);
        return app.quit();
      }

      if (process.env.AME_DEMO_ACT) {
        await win.webContents.executeJavaScript(`mood.lastKeyT -= 10000; mood.blinkAt = 1e12; act.kind = null; startAct('${process.env.AME_DEMO_ACT}');`);
        for (let f = 0; f < 34; f++) {
          const img = await win.webContents.capturePage();
          fs.writeFileSync(path.join(outDir, `a_${String(f).padStart(2, '0')}.png`), img.toPNG());
          await wait(130);
        }
        return app.quit();
      }

      if (process.env.AME_DEMO_FACES) {
        for (const f of process.env.AME_DEMO_FACES.split(',')) {
          const [gx, gy] = f.startsWith('gaze:') ? f.slice(5).split('/').map(Number) : [0, 0];
          const js = f.startsWith('act:') ? `mood.lastKeyT -= 10000; mood.blinkAt = 1e12; act.kind = null; startAct('${f.slice(4)}'); act.t0 -= 900;`
            : f === 'sleep' ? 'mood.lastKeyT -= 200000; mood.blinkAt = 1e12;'
            : f.startsWith('gaze:') ? `mood.lastKeyT -= 5000; mood.blinkAt = 1e12; mouse.seen = true; mouse.x = ${gx}; mouse.y = ${gy};`
            : `setTemp('${f}', 60000); mood.blinkAt = 1e12;`;
          await win.webContents.executeJavaScript(js);
          await wait(900);
          const img = await win.webContents.capturePage();
          fs.writeFileSync(path.join(outDir, `face_${f.replace(/[:/]/g, '_')}.png`), img.toPNG());
          await win.webContents.executeJavaScript('mood.tempUntil = 0; mood.sleeping = false; mood.lastKeyT = performance.now(); act.kind = null;');
        }
        return app.quit();
      }

      if (process.env.AME_DEMO_SEQ) {
        const seq = process.env.AME_DEMO_SEQ.split(',');
        let i = 0, f = 0;
        const typer = setInterval(() => {
          if (i >= seq.length) return clearInterval(typer);
          const tok = seq[i++], c = parseInt(tok, 10);
          if (tok.endsWith('+')) send(c, true);
          else if (tok.endsWith('-')) send(c, false);
          else { send(c, true); setTimeout(() => send(c, false), 60); }
        }, 140);
        const until = Date.now() + seq.length * 140 + 1200;
        const log = [];
        while (Date.now() < until) {
          log.push(await win.webContents.executeJavaScript(
            "[Math.round(handCenter('L')), Math.round(handCenter('R')), hands.L.state, hands.R.state, lastKey || '-', mood.face, Math.round(fhair.x)].join(' ')"));
          const img = await win.webContents.capturePage();
          fs.writeFileSync(path.join(outDir, `f_${String(f++).padStart(3, '0')}.png`), img.toPNG());
          await wait(45);
        }
        fs.writeFileSync(path.join(outDir, 'hands.log'), log.join('\n'));
        return app.quit();
      }

      for (const [name, code] of shots) {
        send(code, true);
        await wait(70);
        const img = await win.webContents.capturePage();
        fs.writeFileSync(path.join(outDir, `demo_${name}.png`), img.toPNG());
        await wait(40); send(code, false); await wait(700);
      }
      app.quit();
    });
  };
}

module.exports = { createDemoRunner };
