// launch a program in a new console window through the pet's bridge, then read its screen back
const path = require('path');
const bridge = require(require('path').resolve(__dirname, '../../app/bridge.js'));
(async () => {
  const pid = await bridge.launch(process.execPath, [path.join(__dirname, 'win-screentest-target.js'), 'arg with space', 'a"quote'], 'D:/');
  console.log('launched pid', pid);
  await new Promise((r) => setTimeout(r, 1800));
  const text = await bridge.screen(pid);
  bridge.stop();
  console.log(text && text.includes('Hello screen 你好 ❯ Yes, I trust this folder') ? 'PASS screen text read back (CJK and ❯ intact)' : 'FAIL got: ' + JSON.stringify(text && text.slice(0, 300)));
  process.exit(0);
})();
