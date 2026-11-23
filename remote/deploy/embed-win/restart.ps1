# restart the AmeEmbed service (wrapper + llama-server)
Stop-ScheduledTask AmeEmbed -ErrorAction SilentlyContinue
Get-CimInstance Win32_Process | Where-Object { $_.Name -eq 'llama-server.exe' -or ($_.Name -eq 'powershell.exe' -and $_.CommandLine -and $_.CommandLine.Contains('ame-embed\run.ps1')) } |
  ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
Start-Sleep 3
Start-ScheduledTask AmeEmbed
"restarted"
