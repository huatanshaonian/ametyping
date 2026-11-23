# One-time setup for AmeEmbed on remote3090 (run as administrator). Safe to run again.
$ErrorActionPreference = 'Stop'
$root = 'D:\ame-embed'

# 1. unpack llama.cpp (CUDA 12.4 build) and its CUDA runtime into bin\
foreach ($z in 'llama-b12640-bin-win-cuda-12.4-x64.zip', 'cudart-llama-bin-win-cuda-12.4-x64.zip') {
  Expand-Archive "$root\dl\$z" -DestinationPath "$root\bin" -Force
}
if (-not (Test-Path "$root\bin\llama-server.exe")) {
  $found = Get-ChildItem "$root\bin" -Recurse -Filter llama-server.exe | Select-Object -First 1
  if ($found) { Get-ChildItem $found.DirectoryName | Move-Item -Destination "$root\bin" -Force }
}

# 2. firewall: only the home LAN may reach port 8090
Get-NetFirewallRule -Name AmeEmbed-LAN -ErrorAction SilentlyContinue | Remove-NetFirewallRule
New-NetFirewallRule -Name AmeEmbed-LAN -DisplayName 'AmeEmbed (LAN 8090)' -Protocol TCP -LocalPort 8090 `
  -Direction Inbound -Action Allow -RemoteAddress 192.168.114.0/24 -Profile Any | Out-Null

# 3. start at boot as SYSTEM, restart if the wrapper itself dies
$action = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File $root\run.ps1"
$trigger = New-ScheduledTaskTrigger -AtStartup
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit ([TimeSpan]::Zero) `
  -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) -StartWhenAvailable
$principal = New-ScheduledTaskPrincipal -UserId 'SYSTEM' -LogonType ServiceAccount -RunLevel Highest
Register-ScheduledTask -TaskName AmeEmbed -Action $action -Trigger $trigger -Settings $settings -Principal $principal -Force | Out-Null
'setup ok'
