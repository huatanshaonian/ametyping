param([Parameter(Mandatory=$true)][string]$Root, [Parameter(Mandatory=$true)][string]$TaskName)
$ErrorActionPreference = 'Stop'
$scriptPath = [IO.Path]::GetFullPath((Join-Path $Root 'remote\agent\agent.js'))
$pattern = '(?i)(?:^|[\s"])' + [regex]::Escape($scriptPath) + '(?:$|[\s"])'
$task = Get-ScheduledTask -TaskName $TaskName
if (-not @($task.Actions | Where-Object { $_.Arguments.Replace('/', '\') -match $pattern }).Count) {
  throw 'The scheduled task does not launch this repository agent; nothing was stopped.'
}
function MatchingAgents {
  @(Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
    Where-Object { $_.CommandLine.Replace('/', '\') -match $pattern })
}
$old = @(MatchingAgents)
Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
foreach ($item in $old) {
  $current = Get-CimInstance Win32_Process -Filter ('ProcessId=' + $item.ProcessId) -ErrorAction SilentlyContinue
  if ($current -and $current.CreationDate -eq $item.CreationDate -and $current.CommandLine.Replace('/', '\') -match $pattern) {
    Stop-Process -Id $item.ProcessId -Force -ErrorAction SilentlyContinue
  }
}
Start-Sleep -Milliseconds 500
Start-ScheduledTask -TaskName $TaskName
$deadline = (Get-Date).AddSeconds(15)
do {
  Start-Sleep -Milliseconds 500
  $agents = @(MatchingAgents | Where-Object { $_.ProcessId -notin $old.ProcessId })
  if ($agents.Count -eq 1) {
    [pscustomobject]@{ restarted = $true; pid = $agents[0].ProcessId; task = $TaskName } | ConvertTo-Json -Compress
    exit 0
  }
} while ((Get-Date) -lt $deadline)
throw 'The task started, but a new agent process was not confirmed.'
