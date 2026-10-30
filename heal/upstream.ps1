<#
  dsh-purge upstream probe —— 只探测，不动运行路径。

  设计原则（这是「一直能用」的关键）：
    - 上游有新版本 -> 只写日志 + 写 upgrade-available.json，绝不自动升级
    - 上游不可达 / 404 / 停更 -> 只写日志，退出码 0
    - 这个任务失败不影响任何东西，因为运行路径根本不读 GitHub

  -Apply  上游有新版时真的 vendor + site + pin（默认不做）
#>
param([switch]$Apply)

$ErrorActionPreference = 'Continue'

$root     = 'C:\Users\Mr.Wang\.dsh\dsh-purge\heal'
$log      = Join-Path $root 'upstream.log'
$report   = Join-Path $root 'upstream-report.json'
$nodeExe  = 'C:\Users\Mr.Wang\AppData\Local\Programs\DeepSeek Harness\resources\runtime\primary-runtime\dependencies\node\bin\node.exe'
$resolver = Join-Path $root 'resolver.mjs'

function Log([string]$m) {
  Add-Content -LiteralPath $log -Value ('{0}  {1}' -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $m) -Encoding UTF8
}

function RunJson([string]$exe, [string[]]$argv) {
  # PS 5.1 没有 ArgumentList（.NET Core API）+ 默认代码页误解码 UTF-8 stdout，两坑都要绕
  $psi = New-Object System.Diagnostics.ProcessStartInfo
  $psi.FileName = $exe
  $quoted = foreach ($a in $argv) { if ($a -match '[\s"]') { '"' + ($a -replace '"', '\"') + '"' } else { $a } }
  $psi.Arguments = ($quoted -join ' ')
  $psi.UseShellExecute = $false
  $psi.RedirectStandardOutput = $true
  $psi.RedirectStandardError = $true
  $psi.StandardOutputEncoding = New-Object System.Text.UTF8Encoding($false)
  $psi.StandardErrorEncoding = New-Object System.Text.UTF8Encoding($false)
  $p = [System.Diagnostics.Process]::Start($psi)
  $so = $p.StandardOutput.ReadToEnd()
  $se = $p.StandardError.ReadToEnd()
  $p.WaitForExit(180000) | Out-Null
  $obj = $null
  try { $obj = $so | ConvertFrom-Json } catch {}
  return [pscustomobject]@{ code = $p.ExitCode; json = $obj; raw = $so; err = $se }
}

Log '--- upstream probe ---'

if (-not (Test-Path $nodeExe))  { Log ('SKIP: node missing: ' + $nodeExe); exit 0 }
if (-not (Test-Path $resolver)) { Log ('SKIP: resolver missing: ' + $resolver); exit 0 }

$cmd = if ($Apply) { 'upstream' } else { 'probe' }
$argv = @($resolver, $cmd)
if ($Apply) { $argv += '--yes' }

$r = RunJson $nodeExe $argv

$result = [ordered]@{
  at       = (Get-Date).ToString('o')
  mode     = $cmd
  exit     = $r.code
  ok       = $false
  local    = $null
  upstream = $null
  newer    = $false
  action   = 'none'
  note     = ''
}

if ($null -eq $r.json) {
  Log ('UNREACHABLE: output unparsable exit=' + $r.code)
  if ($r.raw.Trim()) { Log ('  raw: ' + $r.raw.Trim()) }
  if ($r.err.Trim()) { Log ('  err: ' + $r.err.Trim()) }
  $result.note = 'probe output unparsable'
} elseif (-not $r.json.ok) {
  Log ('UNREACHABLE: ' + ($r.json.probeError + ' ' + $r.json.error))
  $result.note = 'upstream unreachable'
} else {
  $result.ok       = $true
  $result.local    = $r.json.local
  $result.upstream = $r.json.upstream
  $result.newer    = [bool]$r.json.newer
  $result.action   = if ($r.json.action) { $r.json.action } else { 'none' }
  $ageDays         = $r.json.upstreamAgeDays
  $result.note     = "channel=$($r.json.channel) upstreamAgeDays=$ageDays"
  if ($r.json.newer) {
    Log ('NEWER AVAILABLE: local v' + $r.json.local + ' -> upstream v' + $r.json.upstream + ' (action=' + $result.action + ')')
    Log '  NOT auto-applied. To adopt: powershell -File upstream.ps1 -Apply  (or node resolver.mjs upstream --yes)'
  } else {
    Log ('steady: local v' + $r.json.local + ' is current (channel=' + $r.json.channel + ', feed age ' + $ageDays + 'd)')
  }
}

try {
  $result | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath $report -Encoding UTF8
} catch {}

# 探测任务永远退出 0：它是可选的，不该在计划任务里显示成失败
exit 0
