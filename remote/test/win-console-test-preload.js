// Test-only preload: keep console windows created by the real bridge hidden. Production source stays unchanged.
'use strict';
if (process.platform === 'win32' && process.env.AME_TEST_HIDDEN_CONSOLES === '1') {
  const fs = require('fs');
  const path = require('path');
  const target = path.resolve(__dirname, '../../app/console-bridge.ps1').toLowerCase();
  const original = fs.readFileSync;
  fs.readFileSync = function (file, ...args) {
    const data = original.call(fs, file, ...args);
    if (typeof file === 'string' && path.resolve(file).toLowerCase() === target && typeof data === 'string') {
      if (!data.includes('$si.UseShellExecute = $true')) throw new Error('console test preload needs an updated launch pattern');
      return data.replace('$si.UseShellExecute = $true', '$si.UseShellExecute = $true; $si.WindowStyle = [Diagnostics.ProcessWindowStyle]::Hidden');
    }
    return data;
  };
  // fork() gives the isolated service a private IPC channel for graceful shutdown and token cleanup on Windows.
  process.on('message', (m) => { if (m && m.ameTestStop === true) process.emit('SIGTERM'); });
}
