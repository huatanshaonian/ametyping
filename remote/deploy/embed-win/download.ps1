# Downloads for the embedding service on remote3090 (run detached; log in D:\ame-embed\logs\download.log)
$ErrorActionPreference = 'Continue'
$root = 'D:\ame-embed'
$log = "$root\logs\download.log"
$curl = 'C:\Windows\System32\curl.exe'
$proxy = 'http://127.0.0.1:10808'
function Log($m) { "$(Get-Date -Format s) $m" | Out-File -Append -Encoding utf8 $log }

$jobs = @(
  @{ name = 'llama-bin'; url = 'https://github.com/ggml-org/llama.cpp/releases/download/b12640/llama-b12640-bin-win-cuda-12.4-x64.zip'; out = "$root\dl\llama-b12640-bin-win-cuda-12.4-x64.zip"; proxy = $true; size = 358028514 },
  @{ name = 'cudart';    url = 'https://github.com/ggml-org/llama.cpp/releases/download/b12640/cudart-llama-bin-win-cuda-12.4-x64.zip'; out = "$root\dl\cudart-llama-bin-win-cuda-12.4-x64.zip"; proxy = $true; size = 391443627 },
  @{ name = 'model';     url = 'https://hf-mirror.com/Qwen/Qwen3-Embedding-4B-GGUF/resolve/main/Qwen3-Embedding-4B-Q8_0.gguf'; out = "$root\models\Qwen3-Embedding-4B-Q8_0.gguf"; proxy = $false; alt = 'https://huggingface.co/Qwen/Qwen3-Embedding-4B-GGUF/resolve/main/Qwen3-Embedding-4B-Q8_0.gguf' }
)
foreach ($j in $jobs) {
  if ($j.size -and (Test-Path $j.out) -and (Get-Item $j.out).Length -eq $j.size) { Log "skip $($j.name)"; continue }
  Log "start $($j.name)"
  for ($try = 1; $try -le 12; $try++) {
    $u = $j.url; if ($j.alt -and ($try % 2 -eq 0)) { $u = $j.alt }
    $a = @('-L', '--fail', '-C', '-', '--retry', '3', '--speed-limit', '102400', '--speed-time', '60', '-o', $j.out, $u)
    if ($u -ne $j.url) { $a = @('-x', $proxy) + $a }
    if ($j.proxy) { $a = @('-x', $proxy) + $a }
    & $curl -s @a
    if ($LASTEXITCODE -eq 0) { break }
    Log "$($j.name) try $try exit $LASTEXITCODE"
    Start-Sleep 5
  }
  $len = (Get-Item $j.out -ErrorAction SilentlyContinue).Length
  Log "done $($j.name) exit=$LASTEXITCODE bytes=$len"
}
Log 'ALL DONE'
