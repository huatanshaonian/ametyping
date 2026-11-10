// Read-only instructions for connecting another computer to the NAS gateway.
import { h, prefs } from '../util.js';

const CONFIG = {
  "$schema": "https://opencode.ai/config.json",
  "model": "magpie/group/opus-main",
  "agents": {
    "general": {
      "model": "magpie/group/deepseek-worker"
    },
    "explore": {
      "model": "magpie/group/deepseek-worker"
    }
  },
  "providers": {
    "magpie": {
      "name": "Magpie",
      "settings": {
        "baseURL": "https://magapi.huatan.org/v1",
        "apiKey": "{file:~/.config/opencode/.secrets/magpie-nas.key}"
      },
      "models": {
        "group/opus-main": {
          "name": "Opus · 日常",
          "modelID": "group/opus-main",
          "package": "@opencode/ai/providers/anthropic-compatible",
          "limit": {
            "context": 1000000,
            "input": 1000000,
            "output": 64000
          },
          "capabilities": {
            "tools": true,
            "input": [
              "text",
              "image"
            ]
          }
        },
        "devin/claude-opus-5-5": {
          "name": "Opus 5.5 · Devin",
          "modelID": "devin/claude-opus-5-5",
          "package": "@opencode/ai/providers/anthropic-compatible",
          "limit": {
            "context": 1000000,
            "input": 1000000,
            "output": 128000
          },
          "capabilities": {
            "tools": true,
            "input": [
              "text",
              "image"
            ],
            "output": [
              "text"
            ],
            "reasoning": {
              "supported": true,
              "effort": [
                "low",
                "medium",
                "high",
                "xhigh",
                "max"
              ]
            }
          }
        },
        "devin/claude-fable-5-1": {
          "name": "Fable 5.1 · Devin",
          "modelID": "devin/claude-fable-5-1",
          "package": "@opencode/ai/providers/anthropic-compatible",
          "limit": {
            "context": 1000000,
            "input": 1000000,
            "output": 128000
          },
          "capabilities": {
            "tools": true,
            "input": [
              "text",
              "image"
            ],
            "output": [
              "text"
            ],
            "reasoning": {
              "supported": true,
              "effort": [
                "low",
                "medium",
                "high",
                "xhigh",
                "max"
              ]
            }
          }
        },
        "group/gemini-argon": {
          "name": "Gemini Argon",
          "modelID": "group/gemini-argon",
          "package": "@opencode/ai/providers/openai-compatible",
          "limit": {
            "context": 1048576,
            "input": 1048576,
            "output": 65536
          },
          "capabilities": {
            "tools": true,
            "input": [
              "text",
              "image"
            ]
          }
        },
        "group/deepseek-worker": {
          "name": "DeepSeek Flash · 子 Agent",
          "modelID": "group/deepseek-worker",
          "package": "@opencode/ai/providers/openai-compatible",
          "limit": {
            "context": 1048576,
            "input": 1048576,
            "output": 393216
          },
          "capabilities": {
            "tools": true,
            "input": [
              "text",
              "image"
            ]
          }
        },
        "kiro/claude-opus-5.5": {
          "name": "Opus 5.5 · Kiro",
          "modelID": "kiro/claude-opus-5.5",
          "package": "@opencode/ai/providers/anthropic-compatible",
          "limit": {
            "context": 1000000,
            "input": 1000000,
            "output": 64000
          },
          "capabilities": {
            "tools": true,
            "input": [
              "text",
              "image"
            ],
            "output": [
              "text"
            ]
          }
        }
      },
      "package": "@opencode/ai/providers/openai-compatible"
    }
  }
};
const BASE = 'https://magapi.huatan.org/v1';
const WEB = 'https://magpie.huatan.org/';
const configText = JSON.stringify(CONFIG, null, 2) + '\n';
const link = (text, href) => h('a', { text, href, target: '_blank', rel: 'noopener noreferrer' });
const para = text => h('p', { text });
function code(title, text) {
  const pre = h('pre', { tabindex: '0' }, h('code', { text }));
  const status = h('span', { class: 'ocg-copy-note', 'aria-live': 'polite' });
  const copy = h('button', { class: 'btn', type: 'button', text: '复制命令', onclick: async () => {
    try { await navigator.clipboard.writeText(text); status.textContent = '已复制'; }
    catch { const range = document.createRange(); range.selectNodeContents(pre); const selection = window.getSelection(); selection.removeAllRanges(); selection.addRange(range); status.textContent = '已选中，请按 Ctrl+C 复制'; }
  } });
  return h('div', { class: 'ocg-code' }, h('div', { class: 'ocg-code-head' }, h('b', { text: title }), copy, status), pre);
}
const step = (title, ...children) => h('section', { class: 'ocg-step' }, h('h3', { text: title }), ...children);
const fold = (title, ...children) => h('details', {}, h('summary', { text: title }), ...children);

const WIN_INSTALL = String.raw`$bin = Join-Path $env:LOCALAPPDATA 'Programs\OpenCode'
$env:Path = "$bin;$env:Path"
$userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
if (($userPath -split ';') -notcontains $bin) {
  [Environment]::SetEnvironmentVariable('Path', "$bin;$userPath", 'User')
}
opencode.exe --version`;
const WIN_KEY = String.raw`$cfg = Join-Path $env:USERPROFILE '.config\opencode'
$secrets = Join-Path $cfg '.secrets'
New-Item -ItemType Directory -Force $secrets | Out-Null
$secret = Read-Host '粘贴此电脑的 Magpie API key' -AsSecureString
$plain = [Net.NetworkCredential]::new('', $secret).Password
[IO.File]::WriteAllText((Join-Path $secrets 'magpie-nas.key'), $plain, [Text.UTF8Encoding]::new($false))
$sid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
icacls.exe $secrets /inheritance:r /grant:r "*$($sid):(OI)(CI)F"
Remove-Variable plain, secret`;
const WIN_PROXY = String.raw`$serviceSkip = (opencode.exe service get env NO_PROXY)
$skip = @('localhost','127.0.0.1','::1','magapi.huatan.org','magpie.huatan.org')
$skip += ($env:NO_PROXY -split '[,\s]+')
$skip += ($serviceSkip -split '[,\s]+')
$env:NO_PROXY = ($skip | Where-Object { $_ } | Select-Object -Unique) -join ','
[Environment]::SetEnvironmentVariable('NO_PROXY', $env:NO_PROXY, 'User')
opencode.exe service set env NO_PROXY $env:NO_PROXY
opencode.exe service start`;
const WIN_OPTIONAL_PROXY = String.raw`# 仅在确实需要本机 HTTP 代理时设置，端口按自己的代理软件修改
$env:HTTP_PROXY = 'http://127.0.0.1:10808'
$env:HTTPS_PROXY = $env:HTTP_PROXY
opencode.exe service set env HTTP_PROXY $env:HTTP_PROXY
opencode.exe service set env HTTPS_PROXY $env:HTTPS_PROXY
opencode.exe service start`;
const WIN_CHECK = String.raw`Resolve-DnsName magapi.huatan.org
$keyFile = Join-Path $env:USERPROFILE '.config\opencode\.secrets\magpie-nas.key'
$key = (Get-Content -LiteralPath $keyFile -Raw).Trim()
curl.exe --noproxy "*" --fail-with-body -H "Authorization: Bearer $key" https://magapi.huatan.org/v1/models
Remove-Variable key
opencode.exe models
# 可选：会产生一次 DeepSeek 调用
opencode.exe run --model magpie/group/deepseek-worker '不要调用工具，只回复 OK。'
# 在自己的项目目录启动
opencode.exe`;
const LINUX_KEY = String.raw`install -d -m 700 "$HOME/.config/opencode/.secrets"
read -r -s -p '粘贴此电脑的 Magpie API key: ' magpie_key
printf '\n'
(umask 077; printf '%s' "$magpie_key" > "$HOME/.config/opencode/.secrets/magpie-nas.key")
chmod 600 "$HOME/.config/opencode/.secrets/magpie-nas.key"
unset magpie_key`;
const LINUX_PROXY = String.raw`service_skip="$(opencode service get env NO_PROXY)"
export NO_PROXY="localhost,127.0.0.1,::1,magapi.huatan.org,magpie.huatan.org,$NO_PROXY,$no_proxy,$service_skip"
export no_proxy="$NO_PROXY"
opencode service set env NO_PROXY "$NO_PROXY"
opencode service start
# Bash：保留给以后新开的终端；zsh 用户写入 ~/.zshrc
printf '\nexport NO_PROXY=%q\nexport no_proxy="$NO_PROXY"\n' "$NO_PROXY" >> "$HOME/.bashrc"`;
const LINUX_OPTIONAL_PROXY = String.raw`# 仅在需要外网代理时设置；10808 改成自己的 HTTP 代理端口
export HTTP_PROXY='http://127.0.0.1:10808'
export HTTPS_PROXY="$HTTP_PROXY"
opencode service set env HTTP_PROXY "$HTTP_PROXY"
opencode service set env HTTPS_PROXY "$HTTPS_PROXY"
opencode service start`;
const LINUX_CHECK = String.raw`getent ahostsv4 magapi.huatan.org
curl --noproxy '*' --fail-with-body -H "Authorization: Bearer $(cat "$HOME/.config/opencode/.secrets/magpie-nas.key")" https://magapi.huatan.org/v1/models
opencode models
# 可选：会产生一次 DeepSeek 调用
opencode run --model magpie/group/deepseek-worker '不要调用工具，只回复 OK。'
# 在自己的项目目录启动
opencode`;

export function panel() {
  const downloads = new Set(), urls = new Set();
  function pluginDownload() {
    const note = h('span', { class: 'ocg-copy-note', 'aria-live': 'polite' });
    const button = h('button', { class: 'btn', type: 'button', dataset: { download: 'usage-plugin' }, text: '下载 Magpie 用量插件', onclick: async () => {
      const controller = new AbortController(); downloads.add(controller); button.disabled = true; note.textContent = '准备下载…';
      try {
        // Fetch JSON, then save a Blob: download managers cannot take over a .zip URL.
        const response = await fetch('/downloads/opencode-magpie-usage.json', { signal: controller.signal });
        if (!response.ok) throw new Error();
        const pkg = await response.json();
        if (pkg.encoding !== 'base64' || typeof pkg.data !== 'string' || pkg.data.length > 2 * 1024 * 1024) throw new Error();
        const bytes = Uint8Array.from(atob(pkg.data), c => c.charCodeAt(0));
        if (bytes[0] !== 80 || bytes[1] !== 75) throw new Error();
        const url = URL.createObjectURL(new Blob([bytes], { type: 'application/zip' })); urls.add(url);
        const a = h('a', { href: url, download: 'opencode-magpie-usage.zip' }); a.click();
        setTimeout(() => { URL.revokeObjectURL(url); urls.delete(url); }, 10000);
        note.textContent = '已交给浏览器保存';
      } catch (error) { if (error.name !== 'AbortError') note.textContent = '下载失败，请刷新后重试'; }
      finally { downloads.delete(controller); button.disabled = false; }
    } });
    return h('p', {}, button, ' ', note);
  }
  const body = h('div', { class: 'ocg-body', id: 'ocg-body', role: 'tabpanel' });
  const tabs = h('div', { class: 'ocg-tabs', role: 'tablist', 'aria-label': '选择操作系统' });
  const root = h('div', { class: 'ocg' },
    h('h2', { text: 'OpenCode 连接 NAS Magpie' }),
    para('电脑上运行 OpenCode，NAS 统一提供模型和账号。主模型为 Opus，general / explore 子 Agent 使用 DeepSeek Flash。适用 OpenCode 2.x，本机已验证 2.2.0。'),
    h('dl', { class: 'ocg-addresses' }, h('dt', { text: 'API 地址' }), h('dd', {}, h('code', { text: BASE })),
      h('dt', { text: '管理网页' }), h('dd', {}, link(WEB, WEB))),
    tabs, body);
  let os = prefs.get('opencode-guide.os', 'windows');
  if (!['windows', 'linux'].includes(os)) os = 'windows';
  for (const [id, label] of [['windows', 'Windows / PowerShell'], ['linux', 'Linux / Bash']]) tabs.append(h('button', {
    class: 'btn', type: 'button', role: 'tab', text: label, dataset: { os: id }, 'aria-controls': 'ocg-body',
    onclick: () => { os = id; prefs.set('opencode-guide.os', os); render(); },
  }));
  function render() {
    const win = os === 'windows';
    for (const tab of tabs.children) { const active = tab.dataset.os === os; tab.classList.toggle('sel', active); tab.setAttribute('aria-selected', String(active)); }
    body.dataset.os = os;
    body.replaceChildren(
      step('1. 连到 NAS',
        para('同一局域网可以直接使用。外出时安装 Tailscale，登录 NAS 所在的同一尾网，再访问上面的域名；域名本身不会把 NAS 变成公网服务。'),
        para('正常解析：家中局域网为 192.168.114.6；外出为 100.65.10.90。先确认 Tailscale 已连接，再检查 DNS 和代理例外。'),
        win ? h('p', {}, link('安装 Tailscale for Windows', 'https://tailscale.com/docs/install/windows'), '，从托盘登录并连接。') :
          code('Tailscale 安装与连接', 'curl -fsSL https://tailscale.com/install.sh | sh\nsudo tailscale up\ntailscale status')),
      step('2. 安装 OpenCode',
        win ? h('div', {},
          h('p', {}, '从 ', link('官方 CLI 下载页', 'https://opencode.ai/docs/#cli'), ' 选择 Windows x64 / ARM64，解压，将 opencode.exe 放到 %LOCALAPPDATA%\\Programs\\OpenCode。然后执行下面的 PATH 设置。'),
          code('独立 CLI：加入用户 PATH 并检查版本', WIN_INSTALL),
          fold('已有 Node.js LTS：也可以通过 npm 安装', h('p', {}, link('Node.js 官方下载', 'https://nodejs.org/en/download')),
            code('npm 安装（后续命令把 opencode.exe 换成 opencode.cmd）', 'npm.cmd install -g @opencode/cli@2.2.0\nopencode.cmd --version'),
            para('PowerShell 使用 .cmd 可避开 npm 的 .ps1 启动脚本执行策略问题。安装后新开终端；不要安装旧版 opencode-ai 包。'))) :
          code('官方 OpenCode 2.x 安装器', 'curl -fsSL https://opencode.ai/v2/install | bash\n# 安装完成后新开终端，再检查\nopencode --version'),
        para('版本应为 2.x；已有旧版时先核对命令路径，再升级到 2.x。')),
      step('3. 保存这台电脑的 API key',
        h('p', {}, '到 ', link('Magpie 管理网页', WEB), ' 的 API key 管理页，为这台电脑创建或选择允许上述模型的调用 key。网页登录用的 MAGPIE_WEB_KEY 与这里的 API key 是两类密钥。'),
        para('下面的命令会隐藏输入，并写入当前用户的独立密钥文件。每台电脑单独保存自己的 key。'),
        code(win ? 'PowerShell：保存调用 key' : 'Bash：保存调用 key', win ? WIN_KEY : LINUX_KEY)),
      step('4. 放置配置文件',
        para(win ? '配置位置：%USERPROFILE%\\.config\\opencode\\opencode.json' : '配置位置：~/.config/opencode/opencode.json'),
        h('p', {}, h('a', { class: 'btn', href: '/downloads/opencode-magpie.json', download: 'opencode.json', text: '下载六模型配置模板' })),
        para('新安装直接保存到上面的位置。已有配置先备份，再合并 providers.magpie、model 和 agents；不要覆盖自己已有的 MCP、插件或其他供应商。'),
        para('模板用文件引用读取步骤 3 的 key。包含 Opus 日常、Devin Opus、Devin Fable、Gemini Argon、DeepSeek Flash 和直连 Kiro 六个入口。NAS 的账号优先级由 NAS 管理，无需在每台电脑重设。'),
        fold('查看完整配置', code('opencode.json', configText))),
      step('5. 设置代理例外',
        para('只使用 NAS 模型时，客户端无需为模型请求设置外网代理；NAS 负责访问上游。如果机器已设置 HTTP_PROXY / HTTPS_PROXY，NAS 两个域名和本机回环必须直连。'),
        code(win ? 'PowerShell：保留已有条目并添加直连域名' : 'Bash：保留已有条目并添加直连域名', win ? WIN_PROXY : LINUX_PROXY),
        para('OpenCode 服务环境与启动它的终端环境是两处配置。服务变量变更会停止服务，最后的 service start 会重新启动。终端中也需保留 NO_PROXY；Linux 同时设置小写 no_proxy。'),
        win ? para('浏览器走 Windows 系统代理时，在代理例外原列表后追加 magapi.huatan.org;magpie.huatan.org。这里填裸域名，不带 http://、端口或 full:。若另有 v2rayN 内核路由规则，则将 full:magapi.huatan.org、full:magpie.huatan.org 设为 direct 并应用。') :
          para('桌面浏览器若使用 GNOME / KDE 等系统代理，也在其“忽略主机”里加入这两个域名。命令行 curl 的临时强制直连参数是 --noproxy。'),
        fold('可选：安装、MCP 等外网请求还需要本机代理', code('端口按本机代理设置修改', win ? WIN_OPTIONAL_PROXY : LINUX_OPTIONAL_PROXY),
          para('这些是当前终端和 OpenCode 后台服务的代理设置。安装工具若也要长期使用代理，按该工具的方式保存；NAS 域名继续保留在直连例外中。'))),
      step('6. 验证并开始使用',
        code(win ? 'PowerShell：DNS、API 和模型检查' : 'Bash：DNS、API 和模型检查', win ? WIN_CHECK : LINUX_CHECK),
        para('API 有效 key 应返回模型 JSON；在 models 列表中应能找到模板的六个 Magpie 入口。启动后用 /models 选择模型。')),
      fold('可选：把 /usage 换成 Magpie 用量弹窗',
        para('新安装的 /usage 默认是 OpenCode 自带统计。要像当前电脑一样看 NAS 订阅额度，可安装下面的本地插件。'),
        pluginDownload(),
        para(win ? '将 ZIP 中的 opencode-magpie-usage 文件夹放到 %USERPROFILE%\\.config\\opencode\\plugins\\ 下。' : '将 ZIP 中的 opencode-magpie-usage 文件夹放到 ~/.config/opencode/plugins/ 下。'),
        para('在同级 cli.json 的 plugins 数组中追加下面的路径（已有内容保留），重开 OpenCode。支持 /usage、/uasge、Ctrl+R 刷新和 Esc；没有常驻侧栏。'),
        code('~/.config/opencode/cli.json', JSON.stringify({plugins:['./plugins/opencode-magpie-usage']}, null, 2)),
        para('用量读取复用步骤 3 的 key。糖糖与额度提醒另依赖该电脑的 AmeTyping Agent，不随此插件包自动安装。')),
      step('常见情况',
        h('ul', {},
          ...[
            '连接超时：先看 Tailscale / DNS，再区分浏览器系统代理、终端环境变量与 OpenCode 服务环境；系统代理例外不会自动修复全部命令行程序。',
            '401：接口可达，但调用 key 缺失、失效或权限不够。网页密钥不用于 OpenCode。',
            '群晖欢迎页 / 404：可能访问了错误主机或缺少域名反代；先核对完整 API 地址 https://magapi.huatan.org/v1。',
            '现在使用 HTTPS 默认443，群晖验证证书后转到内部3430。旧HTTP80入口保留兼容。之前不能访问，是缺少反代和代理例外，不是必须使用某个固定外部端口。',
            '项目目录的 opencode.json 可能覆盖全局设置；遇到模型不同，先检查项目配置和旧会话保存的模型。',
          ].map(text => h('li', { text })))),
      h('footer', { class: 'ocg-sources' }, '官方资料：', link('安装', 'https://opencode.ai/docs/'), ' · ', link('配置', 'https://opencode.ai/docs/config'), ' · ', link('供应商', 'https://opencode.ai/docs/providers'), ' · ', link('网络与代理', 'https://opencode.ai/docs/network'), ' · ', link('Tailscale Linux', 'https://tailscale.com/docs/install/linux')),
    );
  }
  render();
  return { root, destroy() { for (const controller of downloads) controller.abort(); for (const url of urls) URL.revokeObjectURL(url); downloads.clear(); urls.clear(); } };
}
