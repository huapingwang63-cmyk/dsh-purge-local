# 重启宿主并验收第③件事（memory-hook）
#   powershell -NoProfile -ExecutionPolicy Bypass -File restart-and-verify.ps1
#
# 为什么需要重启：desktop profile 的 patch 只在宿主启动时组合一次。memory-hook
# 刚修好 insert 语法，必须重启才能进树。
$ErrorActionPreference = 'Continue'
$HEAL = 'C:\Users\Mr.Wang\.dsh\dsh-purge\heal'
$AGENTS = 'C:\Users\Mr.Wang\.dsh\AGENTS.md'
$MARKER = '<!-- dsh-memory-hook:auto -->'
$EXE = 'C:\Users\Mr.Wang\AppData\Local\Programs\DeepSeek Harness\DeepSeek Harness.exe'

function Log($m) { Write-Host "$(Get-Date -f 'HH:mm:ss') $m" }
function Read-AgentsAuto {
    $t = [System.IO.File]::ReadAllText($AGENTS, [System.Text.Encoding]::UTF8)
    $i = $t.LastIndexOf($MARKER)
    if ($i -lt 0) { return $null }
    return $t.Substring($i + $MARKER.Length).Trim()
}

Log "=== 重启前基线 ==="
$before = Read-AgentsAuto
if ($null -eq $before) { Log "FAIL: AGENTS.md 里没有自动区标记"; exit 1 }
Log "自动区长度: $($before.Length)"
Log "自动区内容: [$before]"

Log "=== 停止宿主 ==="
Get-Process -Name 'DeepSeek Harness' -ErrorAction SilentlyContinue | Stop-Process -Force
Start-Sleep -Seconds 6
$still = @(Get-Process -Name 'DeepSeek Harness' -ErrorAction SilentlyContinue)
if ($still.Count -gt 0) { Log "WARN: 仍有 $($still.Count) 个进程"; Start-Sleep -Seconds 5 }

Log "=== 启动宿主 ==="
Start-Process $EXE
Log "等待启动（60s）..."
Start-Sleep -Seconds 60
$p = @(Get-Process -Name 'DeepSeek Harness' -ErrorAction SilentlyContinue)
if ($p.Count -eq 0) { Log "FAIL: 宿主没起来"; exit 1 }
Log "OK: $($p.Count) 个进程，最早启动于 $((($p | Sort-Object StartTime | Select-Object -First 1).StartTime))"

Log "=== 跑三件事验收 ==="
& powershell.exe -NoProfile -ExecutionPolicy Bypass -File "$HEAL\verify-after-restart.ps1"
$verifyExit = $LASTEXITCODE

Log "=== 第③件：触发一次 session-stop ==="
Log "memory-hook 挂在 workspace/session-stop，由 archiveSession(stopActivity:true) 发出。"
Log "方式一：在 GUI 里右键任意会话 → 归档会话"
Log "方式二：用 dsh-gui 的镜像实例归档（注意：镜像走 web profile，不加载 desktop 的 patch）"
Log ""
Log "本次验收只做「加载确认」：重启后 memory-hook 若真被加载，宿主日志/行为里应无 not found。"
Log "归档后重跑本脚本即可看到自动区增长。"
Log ""
Log "=== 当前自动区 ==="
$after = Read-AgentsAuto
Log "自动区长度: $($after.Length)"
if ($after.Length -gt $before.Length) {
    Log "PASS 钩子已写入新条目:"
    Log $after
} else {
    Log "（尚无新条目 —— 需要归档一个会话）"
}

Log ""
Log "verify exit=$verifyExit"
Log "重启后请在 GUI 里归档一个会话，再跑一次 verify-after-restart.ps1"