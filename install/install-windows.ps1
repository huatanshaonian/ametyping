# AmeTyping 一键安装（Windows）：糖糖桌宠 + 看板 agent + Claude Code hooks + 开机自启
#
# 运行（任选其一）：
#   irm https://raw.githubusercontent.com/huatanshaonian/ametyping/chat-panel/install/install-windows.ps1 | iex
#   powershell -ExecutionPolicy Bypass -File install\install-windows.ps1        （在已克隆的仓库里）
#
# 需要：Node.js 18+、git（没有会提示用 winget 安装），这台电脑已加入 Tailscale（agent 经它连群晖）。
# 令牌在群晖上生成（脚本会给出命令），粘贴进来时不显示；可以重复运行（已有配置可保留）。
# 无人值守：设了下面这些环境变量就不再提问——AME_KEEP（保留已有 agent.json，y/n）、AME_NAME、AME_TOKEN、
#   AME_CONTROL（y/n）、AME_FILES（all / none / 文件夹逗号分隔）、AME_INSTALL（缺 Node.js/git 时用 winget 装，y/n）。
param(
  [string]$Dir = "$env:USERPROFILE\ametyping",
  [string]$Branch = 'chat-panel',
  [string]$Server = 'ws://100.65.10.90:8788/agent'
)
$ErrorActionPreference = 'Stop'
$Repo = 'https://github.com/huatanshaonian/ametyping.git'
function Step($m) { Write-Host "`n== $m" -ForegroundColor Magenta }
function Info($m) { Write-Host "   $m" }
function Warn($m) { Write-Host "   ! $m" -ForegroundColor Yellow }
function Ask($q, $def, $envName) {
  if ($envName -and (Test-Path "env:$envName")) { return (Get-Item "env:$envName").Value }   # unattended
  $a = Read-Host ("   $q" + $(if ($def) { " [$def]" } else { '' }))
  if ([string]::IsNullOrWhiteSpace($a)) { return $def } else { return $a.Trim() }
}
function Yes($q, $def = 'y', $envName) { return (Ask "$q (y/n)" $def $envName) -match '^[yY]' }
function Need($cmd, $winget, $what) {
  if (Get-Command $cmd -ErrorAction SilentlyContinue) { return }
  Warn "没找到 $what"
  if ((Get-Command winget -ErrorAction SilentlyContinue) -and (Yes "用 winget 安装 $what？" 'y' 'AME_INSTALL')) {
    winget install --id $winget -e --accept-source-agreements --accept-package-agreements
    $env:Path = [Environment]::GetEnvironmentVariable('Path', 'Machine') + ';' + [Environment]::GetEnvironmentVariable('Path', 'User')
  }
  if (-not (Get-Command $cmd -ErrorAction SilentlyContinue)) { throw "请先安装 $what 再运行本脚本（装完可能要重开 PowerShell）" }
}
function WriteUtf8($path, $text) { [IO.File]::WriteAllText($path, $text, (New-Object Text.UTF8Encoding $false)) }   # no BOM: node reads these

# ---------------------------------------------------------------------------------------------------------------
Step '检查环境'
Need 'node' 'OpenJS.NodeJS.LTS' 'Node.js'
Need 'git' 'Git.Git' 'git'
$node = (Get-Command node).Source
$ver = [int]((& $node -v).TrimStart('v').Split('.')[0])
if ($ver -lt 18) { throw "Node.js 版本太旧（$(& $node -v)），需要 18 以上" }
Info "Node.js $(& $node -v)：$node"
$ts = Get-Command tailscale -ErrorAction SilentlyContinue
if ($ts) { try { Info ("Tailscale 地址：" + ((& $ts.Source ip -4) -join ' ')) } catch { Warn 'Tailscale 没有登录？' } } else { Warn '没找到 Tailscale：agent 要经 Tailscale 连到群晖，请先安装并登录' }
if (-not (Get-Command claude -ErrorAction SilentlyContinue)) { Warn '没找到 claude（Claude Code）：hooks 照样安装，装好 Claude Code 后即可生效' }

# the repository: this one if the script runs from inside it, otherwise clone / update $Dir
Step '获取代码'
if ($PSScriptRoot -and (Test-Path (Join-Path $PSScriptRoot '..\app\main.js'))) { $Dir = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path; Info "使用当前仓库：$Dir" }
elseif (Test-Path (Join-Path $Dir '.git')) { Info "更新 $Dir"; git -C $Dir pull --ff-only }
else { Info "克隆到 $Dir"; git clone -b $Branch $Repo $Dir }

Step '安装依赖（糖糖的 Electron 约 100 MB）'
# a running pet / agent from an earlier install holds these files: stop them first (the agent's node outlives its task)
foreach ($t in 'AmeTyping Pet', 'AmeTyping Agent') { Stop-ScheduledTask $t -ErrorAction SilentlyContinue }
Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object CommandLine -like '*agent\agent.js*' | ForEach-Object { Stop-Process -Id $_.ProcessId -Confirm:$false -ErrorAction SilentlyContinue }
Get-Process electron -ErrorAction SilentlyContinue | Where-Object { $_.Path -like "$Dir\app\*" } | Stop-Process -Confirm:$false -ErrorAction SilentlyContinue
Start-Sleep 2
if ($env:HTTPS_PROXY -or $env:HTTP_PROXY) {
  $env:ELECTRON_GET_USE_PROXY = '1'                                   # Electron's downloader ignores the proxy otherwise
  $env:GLOBAL_AGENT_HTTPS_PROXY = $(if ($env:HTTPS_PROXY) { $env:HTTPS_PROXY } else { $env:HTTP_PROXY })
  Info "下载经代理 $env:GLOBAL_AGENT_HTTPS_PROXY"
}
Push-Location (Join-Path $Dir 'remote'); npm ci --omit=dev --no-audit --no-fund; $e1 = $LASTEXITCODE; Pop-Location
if ($e1) { throw 'remote 依赖安装失败' }
Push-Location (Join-Path $Dir 'app'); npm ci --no-audit --no-fund; $e2 = $LASTEXITCODE; Pop-Location
if ($e2) { throw '糖糖（app）依赖安装失败' }

# ---------------------------------------------------------------------------------------------------------------
Step '配置 agent'
$agentFile = Join-Path $Dir 'remote\agent\agent.json'
$control = $true
if ((Test-Path $agentFile) -and (Yes '已有 agent.json，保留它？' 'y' 'AME_KEEP')) {
  $control = ((Get-Content $agentFile -Raw) | ConvertFrom-Json).control -eq $true
} else {
  $server = Ask '看板服务器（群晖的 agent 入口）' $Server
  $name = Ask '这台电脑在看板上的名字' $env:COMPUTERNAME.ToLower() 'AME_NAME'
  Info '在群晖上生成这台电脑的令牌（ssh 到群晖后运行）：'
  Write-Host "     /var/packages/Node.js_v22/target/usr/local/bin/node /volume2/docker/ame-remote/remote/server/setup.js add-agent $name" -ForegroundColor Cyan
  if ($env:AME_TOKEN) { $token = $env:AME_TOKEN } else {
    $sec = Read-Host '   把打印出来的令牌粘贴到这里（不显示）' -AsSecureString
    $token = [Runtime.InteropServices.Marshal]::PtrToStringAuto([Runtime.InteropServices.Marshal]::SecureStringToBSTR($sec))
  }
  if ($token.Trim().Length -lt 30) { throw '令牌不对（太短）' }
  $control = Yes '允许从看板远程控制（回复、审批、在文件夹启动 Claude）？' 'y' 'AME_CONTROL'
  $f = Ask '文件浏览：all=除 C 盘外所有盘，none=不开放，或写文件夹（逗号分隔）' 'all' 'AME_FILES'
  $cfg = [ordered]@{ server = $server; token = $token.Trim(); name = $name; control = $control }
  if ($f -eq 'all') { $cfg.files = [ordered]@{ roots = @('*'); exclude = @('C:') } }
  elseif ($f -ne 'none') { $cfg.files = [ordered]@{ roots = @($f.Split(',') | ForEach-Object { $_.Trim() } | Where-Object { $_ }) } }
  WriteUtf8 $agentFile ($cfg | ConvertTo-Json -Depth 5)
  Info "已写入 $agentFile"
}

# the pet's own switch for remote control (tray: 允许远程控制) follows the answer above
$petDir = Join-Path $env:APPDATA 'AmeTyping'; $petFile = Join-Path $petDir 'settings.json'
New-Item -ItemType Directory -Force $petDir | Out-Null
$pet = @{}; if (Test-Path $petFile) { try { $o = (Get-Content $petFile -Raw) | ConvertFrom-Json; $o.PSObject.Properties | ForEach-Object { $pet[$_.Name] = $_.Value } } catch {} }
$pet['remoteControl'] = $control
WriteUtf8 $petFile ($pet | ConvertTo-Json -Depth 5 -Compress)

Step '安装 Claude Code hooks（原设置会先备份）'
& $node (Join-Path $Dir 'headless\install-hooks.js')

# ---------------------------------------------------------------------------------------------------------------
Step '开机自启（登录后在后台运行）'
$user = "$env:USERDOMAIN\$env:USERNAME"
$principal = New-ScheduledTaskPrincipal -UserId $user -LogonType Interactive -RunLevel Limited
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances IgnoreNew
foreach ($t in 'AmeTyping Pet', 'AmeTyping Agent') {
  if (Get-ScheduledTask -TaskName $t -ErrorAction SilentlyContinue) { Stop-ScheduledTask $t -ErrorAction SilentlyContinue; Unregister-ScheduledTask $t -Confirm:$false }
}

$t1 = New-ScheduledTaskTrigger -AtLogOn -User $user; $t1.Delay = 'PT15S'
$petExe = Join-Path $Dir 'app\node_modules\electron\dist\electron.exe'
Register-ScheduledTask -TaskName 'AmeTyping Pet' -Description '糖糖桌宠' -Principal $principal -Settings $settings -Trigger $t1 `
  -Action (New-ScheduledTaskAction -Execute $petExe -Argument '.' -WorkingDirectory (Join-Path $Dir 'app')) | Out-Null
$t2 = New-ScheduledTaskTrigger -AtLogOn -User $user; $t2.Delay = 'PT20S'
$settings2 = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances IgnoreNew -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1)
Register-ScheduledTask -TaskName 'AmeTyping Agent' -Description 'Ame 看板 agent' -Principal $principal -Settings $settings2 -Trigger $t2 `
  -Action (New-ScheduledTaskAction -Execute 'conhost.exe' -Argument "--headless `"$node`" `"$(Join-Path $Dir 'remote\agent\agent.js')`"" -WorkingDirectory (Join-Path $Dir 'remote')) | Out-Null
Start-ScheduledTask 'AmeTyping Pet'; Start-Sleep 5; Start-ScheduledTask 'AmeTyping Agent'; Start-Sleep 4

$agentUp = Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object CommandLine -like '*agent\agent.js*'
Step '完成'
Info ('糖糖：' + $(if (Get-Process electron -ErrorAction SilentlyContinue | Where-Object { $_.Path -like "$Dir\app\*" }) { '已启动' } else { '没有启动，请看任务计划程序里的 AmeTyping Pet' }))
Info ('agent：' + $(if ($agentUp) { '已启动（后台）' } else { '没有启动，请看任务计划程序里的 AmeTyping Agent' }))
Info '以后每次登录 Windows 都会自动启动；打开 https://win98.huatan.org 应能在「网上邻居」里看到这台电脑。'
Info '已经开着的 Claude Code 会话要重开一次才会用上新 hooks。'
