# 重启后验收：三件事是否真的生效
#   powershell -NoProfile -ExecutionPolicy Bypass -File verify-after-restart.ps1
$ErrorActionPreference = 'Continue'
$NODE = 'C:\Users\Mr.Wang\AppData\Local\Programs\DeepSeek Harness\resources\runtime\primary-runtime\dependencies\node\bin\node.exe'
$HEAL = 'C:\Users\Mr.Wang\.dsh\dsh-purge\heal'
$pass = 0; $fail = 0
function Check($name, $ok, $detail) {
    if ($ok) { $script:pass++; Write-Host ("  PASS  " + $name + $(if ($detail) { " -- $detail" } else { "" })) -ForegroundColor Green }
    else     { $script:fail++; Write-Host ("  FAIL  " + $name + $(if ($detail) { " -- $detail" } else { "" })) -ForegroundColor Red }
}

Write-Host "`n=== 0. 宿主存活 ==="
$host0 = @(Get-Process -Name 'DeepSeek Harness' -ErrorAction SilentlyContinue)
Check "宿主进程在跑" ($host0.Count -gt 0) "$($host0.Count) 个进程"

Write-Host "`n=== 1. GUI 接入（dsh-gui.mjs） ==="
$out = & $NODE "$HEAL\dsh-gui.mjs" --json 2>&1 | Out-String
if ($LASTEXITCODE -eq 0) {
    $j = $out | ConvertFrom-Json
    Check "dsh-gui.mjs 自验通过" ($j.verified.status -eq 200) "HTTP $($j.verified.status), $($j.verified.len) 字节"
    Check "cookie 已 mint" ($j.cookiePair -like 'dsh-auth-*') $j.baseUrl
    $j.baseUrl | Set-Content "$HEAL\last-gui-baseurl.txt" -Encoding UTF8
} else {
    Check "dsh-gui.mjs 自验通过" $false ($out.Trim() -split "`n" | Select-Object -Last 2)
}

Write-Host "`n=== 2. 计划任务（DSH Self Check） ==="
$q = schtasks /Query /TN "DSH Self Check" /V /FO LIST 2>&1 | Out-String
Check "任务存在" ($q -notmatch 'ERROR') ""
$next = ([regex]::Match($q, 'Next Run Time:\s*(.+)')).Groups[1].Value.Trim()
$last = ([regex]::Match($q, 'Last Result:\s*(.+)')).Groups[1].Value.Trim()
Check "已调度" ($next.Length -gt 0) "Next=$next"
Check "上次执行成功" ($last -eq '0') "LastResult=$last"
$verdict = (Get-Content "$HEAL\self-check.log" -Tail 1 -ErrorAction SilentlyContinue)
Write-Host "  自检末行: $verdict"

Write-Host "`n=== 3. 会话记忆钩子（memory-hook） ==="
# 3a 插件文件与挂载
Check "插件文件在" (Test-Path "$HEAL\dsh-memory-hook.mjs") ""
$yml = Get-Content 'C:\Users\Mr.Wang\.dsh\profiles\desktop\cordis.patch.yml' -Raw
Check "profile 已挂载" ($yml -match 'id:\s*memory-hook') ""
Check "自动区标记已建立" ((Get-Content 'C:\Users\Mr.Wang\.dsh\AGENTS.md' -Raw) -match 'dsh-memory-hook:auto') ""
# 3b 插件真的被宿主加载了吗 —— 看宿主进程有没有持有这个文件
$loaded = $false
foreach ($p in $host0) {
    try { if ($p.Modules.Count -gt 0) { } } catch { }
}
# 更直接的证据：AGENTS.md 自动区是否有重启后新增条目
$agents = Get-Content 'C:\Users\Mr.Wang\.dsh\AGENTS.md' -Raw
$marker = '<!-- dsh-memory-hook:auto -->'
$auto = $agents.Substring($agents.IndexOf($marker) + $marker.Length).Trim()
Check "自动区已有条目（说明 stop 事件触发过）" ($auto.Length -gt 0) $(if ($auto.Length -gt 0) { ($auto -split "`n")[0].Trim() } else { "自动区为空 -- 需要手动 stop 一个会话再看" })

Write-Host "`n=== 汇总 ==="
Write-Host "ok=$pass fail=$fail" -ForegroundColor $(if ($fail -eq 0) { 'Green' } else { 'Yellow' })
if ($fail -gt 0) {
    Write-Host "`n排查提示：" -ForegroundColor Yellow
    Write-Host "  - memory-hook 未生效: 看宿主启动日志有无 memory-hook 加载错误；确认 cordis.patch.yml 是合法 YAML"
    Write-Host "  - 自动区为空: 钩子挂在 workspace/session-stop，需要一个会话被真正 stop 才触发"
    Write-Host "  - dsh-gui 失败: 先 --stop 再重跑，看 gui-helper.log"
}
exit $(if ($fail -eq 0) { 0 } else { 1 })