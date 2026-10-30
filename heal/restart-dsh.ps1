$ErrorActionPreference = 'Continue'
$log = 'C:\Users\Mr.Wang\.dsh\dsh-purge\restart.log'
function Log($m) { "$(Get-Date -f 'yyyy-MM-dd HH:mm:ss') $m" | Add-Content $log -Encoding UTF8 }

$exe   = 'C:\Users\Mr.Wang\AppData\Local\Programs\DeepSeek Harness\DeepSeek Harness.exe'
$bcNew = 'C:\Users\Mr.Wang\.dsh\profiles\desktop\node_modules\billion-context'
$bcOld = "$bcNew.0.1.202.bak"

Log '=== restart requested (billion-context 0.1.208 + mcp-browser + maxDepth 3) ==='

Get-Process -Name 'DeepSeek Harness' -ErrorAction SilentlyContinue | Stop-Process -Force
Start-Sleep -Seconds 5
Log 'host stopped'
if (Get-Process -Name 'DeepSeek Harness' -ErrorAction SilentlyContinue) {
    Log 'WARN: processes still alive after Stop-Process'
    Start-Sleep -Seconds 5
}

Start-Process $exe
Log 'host launched, waiting 50s for boot'
Start-Sleep -Seconds 50

$p = @(Get-Process -Name 'DeepSeek Harness' -ErrorAction SilentlyContinue)
if ($p.Count -gt 0) {
    Log "OK: $($p.Count) process(es) alive - no rollback needed"
    exit 0
}

Log 'FAILED: host not running, rolling back billion-context to 0.1.202'
if (Test-Path $bcOld) {
    Remove-Item $bcNew -Recurse -Force -ErrorAction SilentlyContinue
    Rename-Item -Path $bcOld -NewName 'billion-context'
    Log 'rolled back to 0.1.202'
    Start-Process $exe
    Log 'host relaunched after rollback, waiting 40s'
    Start-Sleep -Seconds 40
    $p2 = @(Get-Process -Name 'DeepSeek Harness' -ErrorAction SilentlyContinue)
    if ($p2.Count -gt 0) { Log "after rollback: alive ($($p2.Count))" }
    else { Log 'after rollback: STILL DEAD - check cordis.patch.yml mcp-browser entry' }
} else {
    Log 'no backup found - manual recovery needed'
}
