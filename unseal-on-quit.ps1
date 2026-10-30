param([switch]$Start,[switch]$Probe)
$ErrorActionPreference = 'Continue'
$res  = 'C:\Users\Mr.Wang\AppData\Local\Programs\DeepSeek Harness\resources'
$asar = Join-Path $res 'app.asar'
$app  = Join-Path $res 'app'
$exe  = 'C:\Users\Mr.Wang\AppData\Local\Programs\DeepSeek Harness\DeepSeek Harness.exe'
$log  = 'C:\Users\Mr.Wang\.dsh\dsh-purge\unseal.log'

function Log([string]$m) {
  $line = '{0}  {1}' -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $m
  Add-Content -LiteralPath $log -Value $line -Encoding UTF8
}

Log '=== unseal watcher start ==='
Log ('asar=' + $asar)
Log ('app=' + $app)
if ($Probe) { Log 'PROBE ok, exiting'; exit 0 }

# wait for host to fully quit (max 45 min)
$deadline = (Get-Date).AddMinutes(45)
while ((Get-Date) -lt $deadline) {
  $procs = @(Get-Process -Name 'DeepSeek Harness' -ErrorAction SilentlyContinue)
  if ($procs.Count -eq 0) { break }
  Start-Sleep -Seconds 3
}
$still = @(Get-Process -Name 'DeepSeek Harness' -ErrorAction SilentlyContinue)
if ($still.Count -gt 0) {
  Log ('ABORT: host still running (' + $still.Count + ' procs); rerun this script later.')
  exit 1
}
Log 'host fully exited'
Start-Sleep -Seconds 2

if (-not (Test-Path -LiteralPath $app)) {
  Log 'ABORT: resources\app missing; renaming asar would break startup.'
  exit 1
}

if (Test-Path -LiteralPath $asar) {
  $bak = ('{0}.purge-unsealed-{1}.bak' -f $asar, (Get-Date -Format 'yyyyMMdd-HHmmss'))
  $ok = $false
  for ($i = 1; $i -le 20; $i++) {
    try {
      Move-Item -LiteralPath $asar -Destination $bak -ErrorAction Stop
      Log ('renamed -> ' + (Split-Path $bak -Leaf))
      $ok = $true
      break
    } catch {
      Log ('rename try ' + $i + ' failed: ' + $_.Exception.Message)
      Start-Sleep -Seconds 3
    }
  }
  if (-not $ok) { Log 'ABORT: app.asar locked; rerun later.'; exit 1 }
} else {
  Log 'app.asar already absent; nothing to rename'
}

if (Test-Path -LiteralPath $asar) { Log 'FATAL: app.asar still present'; exit 1 }
Log ('DONE: resources\app now active, package.json=' + (Test-Path -LiteralPath (Join-Path $app 'package.json')))

if ($Start) {
  Log 'starting host'
  Start-Process -FilePath $exe
}
