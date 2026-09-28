# AmeTyping · 糖糖敲键盘桌宠

A Bongo-Cat–style desktop pet for Windows: Ame (糖糖 / 超てんちゃん) from *NEEDY GIRL OVERDOSE* sits behind a 75% keyboard and types along with you — the key you press is the key she hits. Optional Claude Code integration shows what your Claude sessions are doing in a Windose-style panel under her.

Windows 桌宠：Q 版糖糖坐在一把 75% 键盘后面，你按哪个键她就敲哪个键。可选接入 Claude Code，在她下面用 Windose 风格的对话框实时显示每个会话的进度。

## 下载 / Download

到 [Releases](../../releases) 下载 `AmeTyping-portable.exe`，双击即可运行（单文件便携版，首次启动要解压，会慢几秒）。

Grab `AmeTyping-portable.exe` from [Releases](../../releases) and run it. It is a single-file portable build; the first launch takes a few seconds to unpack.

## 功能

- **跟着你打字**：全局键盘钩子，按键映射到 GravaStar 75% 配列上的对应键；双手按指法分区、不交叉，组合键（Ctrl+Z 等）会一只手按住修饰键。
- **表情与小动作**：打字速度、退格、回车、空闲都会改变表情；空闲时眼睛跟着鼠标看，偶尔打哈欠、捧杯子喝茶，久了会睡着。点她一下会脸红。
- **键盘**：手绘质感的 75% 键盘，按键有淡粉色涟漪光扩散，底部 RGB 背光；托盘可切换 NGO 主题键帽。
- **Claude Code 面板**（可选）：左边是会话列表（标题、状态、未读红点），右边是选中会话的进度日志；可拖动、可拉伸，和糖糖左右/上下贴边联动。
- **窗口**：透明区域逐像素鼠标穿透；拖动她本体移动，拖右下角缩放；托盘菜单有大小、朝向、键帽主题、鼠标穿透、开机自启等。

## 隐私

- 键盘钩子（[uiohook-napi](https://github.com/SnosMe/uiohook-napi)）**只读取键码**（哪个物理键），不记录、不保存、不上传你输入的文字。
- 程序不联网。Claude Code 面板只监听本机 `127.0.0.1:3940`，数据只来自你自己配置的 hook。

## 接入 Claude Code（可选）

1. 装好 [Node.js](https://nodejs.org/)。
2. 把本仓库的 `hook-relay.js` 和 `permission-hook.js` 放到任意位置。
3. 参考 [`claude-hooks.example.json`](claude-hooks.example.json)，把其中的 `hooks` 合并进 `~/.claude/settings.json`，并把两个脚本的路径改成实际路径。
4. 开着糖糖用 Claude Code，面板会在有会话活动时自动出现；托盘菜单「打开 Claude 面板」也能手动叫出来。

### 面板模式

权限确认卡片在两种模式下都会弹出，显示工具名、工作目录、命令／文件路径和完整参数，提供「允许」「拒绝」。终端仍可回答；请求断开或收到后续工具／结束事件时，面板撤掉对应卡片，过期按钮不能再次决定。糖糖没开时 hook 静默退出，继续原来的终端确认流程。

`PermissionRequest` 必须是同步 command hook（不要设置 `async: true`），示例超时为 120 秒。面板最多等待 105 秒，脚本自身等待 110 秒；超时不自动允许或拒绝，交回 Claude 原有权限流程。请同时更新 `hook-relay.js`，后续事件才能及时清理卡片。协议见 [Claude Code hooks 文档](https://code.claude.com/docs/en/hooks#permissionrequest)。

托盘菜单「面板模式」可以切换：

- **弹出进度**（默认）：有动静时弹出一行行进度，停下后自动收起。
- **常驻对话**：面板一直在。右边是这个会话的完整对话（从 transcript 读取），底下可以直接回复：
  - 会话开在终端里：回复会直接打进那个终端（`WriteConsoleInput`，不抢焦点、不模拟全局按键），和你在终端里敲的一样；Claude 正忙时会进入排队。
  - 会话已经关了：用 `claude -p --resume <id>` 在后台续上，结果照样出现在面板里（需要确认权限的操作会被跳过）。
  - IDE 插件 / 桌面 App 里的会话没有终端可打字，只能看。
  - 会话正在等你确认（权限卡片未处理，或终端里有提问 / 选择框）时，回复会被拦下，免得文字被打进确认框里；先在卡片或终端里处理掉再发。

`hook-relay.js` 读取 hook 事件，生成一行中文进度（在读 / 在改 / 在跑 / 要你确认 / 完成了……），会话标题取自该会话 transcript 里的自定义标题，然后 POST 到本机 3940 端口。它 0.7 秒内必定退出，不会拖慢 Claude。

## 从源码运行 / 打包

```bash
cd app
npm install
npm start                 # 开发运行
npm run dist              # 打包到 ../dist/AmeTyping-win32-x64
npx electron-builder --win portable --prepackaged ../dist/AmeTyping-win32-x64   # 单文件便携版 -> ../release
```

打包前先关掉正在运行的 AmeTyping，否则 `dist` 会覆盖失败。

技术栈：Electron 33（透明无边框窗口）、Canvas 2D 分层绑定（头 / 双马尾 / 躯干 / 表情补丁 / 视线补丁 / 悬浮手），`uiohook-napi` 全局键鼠钩子。

## 授权与声明

- **代码**：MIT License，见 [LICENSE](LICENSE)。
- **角色与素材**：糖糖（超てんちゃん）及《NEEDY GIRL OVERDOSE》相关角色、世界观、Windose 界面风格版权归 WSS playground / xemono（にゃるら）所有。本项目是非官方、非商业的同人作品；`app/assets/` 下的立绘、手、键帽等为 AI 辅助绘制的二次创作，对话框底图与音效来自或参照原作。**素材仅限非商业用途**，不适用 MIT 授权。
- **字体**：PixelMplus12（M+ FONT LICENSE）。
