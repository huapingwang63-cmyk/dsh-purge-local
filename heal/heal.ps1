<#
  dsh-purge heal

  两种模式：
    1) 宿主被官方更新覆盖（resources/app.asar 回来了）-> 解包 + 重打全部补丁 + 把 asar 改名
    2) 常规巡检（asar 不在）-> 只跑契约层自检（resolver check），坏了就 site + pin

  -Wait   宿主在跑时最多等 30 分钟，等它退出再动手
  -Start  做完后如果宿主没在跑，把它启动起来
  -Quiet  只写一行 verdict 到日志（给计划任务用）
#>
param([switch]$Wait, [switch]$Start, [switch]$Quiet)

$ErrorActionPreference = 'Continue'

$root     = 'C:\Users\Mr.Wang\.dsh\dsh-purge\heal'
$log      = Join-Path $root 'heal.log'
$verdict  = Join-Path $root 'heal-verdict.json'
$nodeExe  = 'C:\Users\Mr.Wang\AppData\Local\Programs\DeepSeek Harness\resources\runtime\primary-runtime\dependencies\node\bin\node.exe'
$applyMjs = Join-Path $root 'apply.mjs'
$resolver = Join-Path $root 'resolver.mjs'
$hostExe  = 'C:\Users\Mr.Wang\AppData\Local\Programs\DeepSeek Harness\DeepSeek Harness.exe'
$res      = 'C:\Users\Mr.Wang\AppData\Local\Programs\DeepSeek Harness\resources'
$asar     = Join-Path $res 'app.asar'

function Log([string]$m) {
  Add-Content -LiteralPath $log -Value ('{0}  {1}' -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $m) -Encoding UTF8
}

function RunJson([string]$exe, [string[]]$argv) {
  # PS 5.1 会用控制台代码页(936)误解码子进程 UTF-8 输出 -> 引号被吞 -> JSON 解析炸。
  # 必须显式指定 StandardOutputEncoding。
  # ⚠ PS 5.1 没有 ProcessStartInfo.ArgumentList（那是 .NET Core 才有的 API），
  #   只能拼 Arguments 字符串；路径全在本机固定位置且不含空格以外的怪字符，用引号包住即可。
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
  $code = $p.ExitCode
  $obj = $null
  try { $obj = $so | ConvertFrom-Json } catch {}
  return [pscustomobject]@{ code = $code; json = $obj; raw = $so; err = $se }
}

function HostRunning {
  $p = @(Get-Process -Name 'DeepSeek Harness' -ErrorAction SilentlyContinue)
  return ($p.Count -gt 0)
}

function WriteVerdict([string]$state, [string]$detail) {
  $o = [ordered]@{
    at      = (Get-Date).ToString('o')
    state   = $state
    detail  = $detail
    asar    = (Test-Path $asar)
    hostUp  = (HostRunning)
  }
  try { $o | ConvertTo-Json -Compress | Set-Content -LiteralPath $verdict -Encoding UTF8 } catch {}
}

# ---------------- 契约层自检（asar 在不在都要跑） ----------------

function Invoke-Contract([string]$stage) {
  if (-not (Test-Path $resolver)) { Log ('CONTRACT: resolver.mjs missing: ' + $resolver); return $false }
  $c = RunJson $nodeExe @($resolver, 'check')
  if ($null -eq $c.json) {
    Log ('CONTRACT: check output unparsable (' + $stage + ')'); Log ('  raw: ' + $c.raw.Trim()); Log ('  err: ' + $c.err.Trim())
    return $false
  }
  if ($c.json.ok) {
    Log ('CONTRACT: ok — locked v' + $c.json.vendor.version + ', integrity verified, profile pinned')
    return $true
  }
  Log ('CONTRACT: BROKEN after ' + $stage + ' -> ' + (($c.json.problems) -join '; '))
  Log 'CONTRACT: repairing (site + pin)'

  $s = RunJson $nodeExe @($resolver, 'site')
  if (-not ($s.json -and $s.json.ok)) {
    Log ('CONTRACT: site failed exit=' + $s.code + ' raw=' + $s.raw.Trim() + ' err=' + $s.err.Trim())
    return $false
  }
  Log ('CONTRACT: alias re-sited v' + $s.json.version + ' entries=' + $s.json.entries)

  $p = RunJson $nodeExe @($resolver, 'pin', '--yes')
  if (-not ($p.json -and $p.json.ok)) {
    Log ('CONTRACT: pin failed exit=' + $p.code + ' raw=' + $p.raw.Trim() + ' err=' + $p.err.Trim())
    return $false
  }
  Log ('CONTRACT: pin -> ' + $p.json.spec + ' (changed=' + $p.json.changed + ', reason=' + $p.json.reason + ')')

  $c2 = RunJson $nodeExe @($resolver, 'check')
  if ($c2.json -and $c2.json.ok) { Log 'CONTRACT: repaired and verified'; return $true }
  $why = if ($c2.json) { ($c2.json.problems) -join '; ' } else { 'check unparsable' }
  Log ('CONTRACT: STILL BROKEN -> ' + $why)
  return $false
}

Log '--- heal run ---'
if (-not $Quiet) { } else { Log 'mode: quiet' }

if (-not (Test-Path $nodeExe)) { Log ('ABORT: node missing: ' + $nodeExe); WriteVerdict 'abort' 'node missing'; exit 1 }
if (-not (Test-Path $applyMjs)) { Log ('ABORT: apply.mjs missing: ' + $applyMjs); WriteVerdict 'abort' 'apply.mjs missing'; exit 1 }

# ---------------- 情况 1：asar 不存在 -> 常规巡检 ----------------

if (-not (Test-Path $asar)) {
  Log 'app.asar absent -> unpacked tree already active'
  $contractOk = Invoke-Contract 'routine'
  if ($contractOk) { WriteVerdict 'steady' 'asar absent, contract ok' } else { WriteVerdict 'contract-broken' 'asar absent, contract repair failed' }
  if ($Start -and -not (HostRunning)) { Log 'starting host'; Start-Process -FilePath $hostExe }
  if ($contractOk) { exit 0 } else { exit 1 }
}

# ---------------- 情况 2：asar 回来了 -> 需要重建 ----------------

Log 'app.asar present -> official update likely restored it; heal needed'

if (HostRunning) {
  if (-not $Wait) { Log 'host running and -Wait not set; deferring to next run'; WriteVerdict 'deferred' 'asar present, host running'; exit 0 }
  Log 'waiting for host to quit (max 30 min)'
  $deadline = (Get-Date).AddMinutes(30)
  while ((Get-Date) -lt $deadline) {
    if (-not (HostRunning)) { break }
    Start-Sleep -Seconds 4
  }
  if (HostRunning) { Log 'ABORT: host still running after wait window'; WriteVerdict 'abort' 'host never quit'; exit 1 }
  Start-Sleep -Seconds 2
}

Log 'running apply.mjs'
$out = & $nodeExe $applyMjs 2>&1
$code = $LASTEXITCODE
foreach ($line in $out) { Log ('  ' + $line) }
Log ('apply.mjs exit = ' + $code)
if ($code -ne 0) { WriteVerdict 'apply-failed' "exit $code"; exit $code }

if (Test-Path $asar) {
  Log 'WARN: app.asar still present after apply; host will keep loading the archive'
  WriteVerdict 'asar-stuck' 'apply finished but asar remains'
  exit 1
}
Log 'healed: resources/app is now authoritative'

# asar 重建完成后，契约层不一定被 apply 修复（apply 只重建 node_modules 之外的宿主树；
# profiles/desktop/node_modules/dsh-purge-community 是别名包，可能被解包覆盖回官方内容）
$contractOk = Invoke-Contract 'apply'
if (-not $contractOk) { Log 'WARN: contract layer broken after apply — host patches are live but the alias package needs attention' }

if ($Start -and -not (HostRunning)) { Log 'starting host'; Start-Process -FilePath $hostExe }
if ($contractOk) { WriteVerdict 'healed' 'asar unsealed, patches applied, contract ok' } else { WriteVerdict 'healed-contract-broken' 'asar unsealed, patches applied, contract repair failed' }
exit 0
