param(
  [switch]$Fix,
  [switch]$Quiet,
  [string]$Out
)
# DSH 自检包装器：调用 self-check.mjs，把结论写 heal\self-check.log，JSON 全文写 self-check-latest.json
#
# 为什么不直接 `& $node ... 2>&1`：
#   PowerShell 5.1 用 [Console]::OutputEncoding（本机 GBK/936）解码子进程 stdout。
#   self-check.mjs 输出的是 UTF-8 中文，经 GBK 误解码后多字节序列被截断，字符串里的
#   引号字节被吞掉 -> JSON 语法崩 -> ConvertFrom-Json 报 "传入的对象无效，应为':'或'}'"。
#   现象是"同一份输出有时能解析有时不能"，实际取决于中文字节是否恰好落在引号上。
#   修法：用 System.Diagnostics.Process 显式设 StandardOutputEncoding = UTF8，
#   绕开 PowerShell 的管道解码。
# 另注：文件必须以 UTF-8 with BOM 保存，否则 PowerShell 5.1 读中文脚本同样乱码。

$ErrorActionPreference = 'Continue'
$root   = 'C:\Users\Mr.Wang\.dsh\dsh-purge\heal'
$log    = Join-Path $root 'self-check.log'
$latest = Join-Path $root 'self-check-latest.json'
$node   = 'C:\Users\Mr.Wang\AppData\Local\Programs\DeepSeek Harness\resources\runtime\primary-runtime\dependencies\node\bin\node.exe'
$mjs    = Join-Path $root 'self-check.mjs'

function Log([string]$m) {
  Add-Content -LiteralPath $log -Value ('{0}  {1}' -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $m) -Encoding UTF8
}

if (-not (Test-Path $node)) { Log 'ABORT: node missing'; exit 2 }
if (-not (Test-Path $mjs))  { Log 'ABORT: self-check.mjs missing'; exit 2 }

$argList = New-Object System.Collections.Generic.List[string]
$argList.Add('"' + $mjs + '"')
$argList.Add('--json')
if ($Fix) { $argList.Add('--fix') }

$utf8 = New-Object System.Text.UTF8Encoding($false)
$psi = New-Object System.Diagnostics.ProcessStartInfo
$psi.FileName               = $node
$psi.Arguments              = ($argList -join ' ')
$psi.UseShellExecute        = $false
$psi.RedirectStandardOutput = $true
$psi.RedirectStandardError  = $true
$psi.StandardOutputEncoding = $utf8
$psi.StandardErrorEncoding  = $utf8
$psi.CreateNoWindow         = $true

$code = 2
$text = ''
try {
  $proc = [System.Diagnostics.Process]::Start($psi)
  $text = $proc.StandardOutput.ReadToEnd()
  $errText = $proc.StandardError.ReadToEnd()
  $proc.WaitForExit()
  $code = $proc.ExitCode
  if ($errText) { $text = $text + "`n" + $errText }
} catch {
  Log ('SPAWN-FAIL: ' + $_.Exception.Message)
  exit 2
}

if ($Out) { $text | Set-Content -LiteralPath $Out -Encoding UTF8 }

# 从第一个 { 截到最后一个 }，容忍尾部混入的 stderr 文本
$start = $text.IndexOf('{')
$end   = $text.LastIndexOf('}')
if ($start -ge 0 -and $end -gt $start) {
  $jsonText = $text.Substring($start, $end - $start + 1)
  try {
    $obj = $jsonText | ConvertFrom-Json
    $jsonText | Set-Content -LiteralPath $latest -Encoding UTF8
    $line = 'verdict={0} ok={1} warn={2} fail={3} fixed={4} {5}ms' -f $obj.verdict, $obj.tally.ok, $obj.tally.warn, $obj.tally.fail, $obj.tally.fixed, $obj.elapsedMs
    Log $line
    $bad = @($obj.results | Where-Object { $_.status -eq 'fail' -or $_.status -eq 'warn' })
    foreach ($b in $bad) { Log ('  [{0}] {1} {2} — {3}' -f $b.status, $b.layer, $b.id, $b.msg) }
    if (-not $Quiet) {
      Write-Output $line
      foreach ($b in $bad) { Write-Output ('  [{0}] {1} {2} — {3}' -f $b.status, $b.layer, $b.id, $b.msg) }
    }
  } catch {
    # 只记摘要，不把整份 JSON 倒进日志
    Log ('PARSE-FAIL: ' + $_.Exception.Message)
    Log ('  jsonLen=' + $jsonText.Length + ' head=' + $jsonText.Substring(0, [Math]::Min(200, $jsonText.Length)))
    if (-not $Quiet) { Write-Output 'PARSE-FAIL: 体检输出无法解析' }
  }
} else {
  Log 'NO-JSON: 体检未产出 JSON'
  Log ($text.Substring(0, [Math]::Min(2000, $text.Length)))
}

exit $code