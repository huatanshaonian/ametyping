# AmeEmbed: keeps llama-server (Qwen3-Embedding-4B, Q8_0) running on this machine.
# Started at boot by the scheduled task "AmeEmbed" (as SYSTEM). Settings live in D:\ame-embed\config.json.
#   logs\server.log    llama-server's own log (--log-file, plain UTF-8); the previous run's is server.log.1
#   logs\wrapper.log   when this wrapper started / restarted the server, and its exit codes
$ErrorActionPreference = 'Continue'
$root = 'D:\ame-embed'
$cfg = Get-Content "$root\config.json" -Raw | ConvertFrom-Json
$log = "$root\logs\server.log"
$wrap = "$root\logs\wrapper.log"
function Note($m) { "$(Get-Date -Format s) $m" | Out-File -Append -Encoding utf8 $wrap }

while ($true) {
  # each start begins a fresh server.log; the one before is kept as server.log.1
  if (Test-Path $log) { Move-Item $log "$log.1" -Force }
  $sa = @(
    '-m', "$root\models\$($cfg.model)",
    '--embedding', '--pooling', 'last',
    '-ngl', '99',
    '-c', "$($cfg.ctx)", '-np', "$($cfg.slots)",
    '-b', "$($cfg.batch)", '-ub', "$($cfg.batch)",
    '-fa', 'on', '-ctk', 'q8_0', '-ctv', 'q8_0',
    '--host', $cfg.host, '--port', "$($cfg.port)",
    '--api-key-file', "$root\api-key.txt",
    '--no-webui', '--metrics', '-a', $cfg.alias,
    '--log-file', $log, '--log-colors', 'off'
  )
  Note "starting llama-server $($sa -join ' ')"
  & "$root\bin\llama-server.exe" @sa *> $null
  Note "llama-server exited with $LASTEXITCODE; restarting in 10 s"
  Start-Sleep 10
}
