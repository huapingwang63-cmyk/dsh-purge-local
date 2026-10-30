# register-tasks.ps1 -- recreate the three watchdog scheduled tasks and the logon launcher.
#
# These live outside the repo (Task Scheduler DB + Startup folder), so a fresh
# clone has to rebuild them. Paths are derived at run time, so the script works
# regardless of the user name or where .dsh lives.
#
# Usage:
#   pwsh -File install\register-tasks.ps1                 # create/refresh all three + startup vbs
#   pwsh -File install\register-tasks.ps1 -DryRun         # print what would run
#   pwsh -File install\register-tasks.ps1 -Remove         # delete all three + startup vbs
#   pwsh -File install\register-tasks.ps1 -Suffix -TEST   # create look-alike tasks for testing
#
# Notes learned the hard way:
#   * Do NOT pass /ru or /rp -- that flips the task to "run whether user is
#     logged on or not" and needs a stored password / admin rights.
#     Leaving them out keeps LogonType=InteractiveToken, which is what the
#     working tasks use.
#   * An ONLOGON task needs admin on this box, so the logon launcher is a .vbs
#     dropped into the Startup folder instead.
#   * A .vbs must be pure ASCII: cscript reads it as ANSI(936) and a UTF-8
#     Chinese comment swallows the following newline.

[CmdletBinding()]
param(
    [switch]$DryRun,
    [switch]$Remove,
    [string]$Suffix = '',
    [string]$DshHome = $(if ($env:DSH_HOME) { $env:DSH_HOME } else { Join-Path $env:USERPROFILE '.dsh' })
)

$ErrorActionPreference = 'Stop'

$heal    = Join-Path $DshHome 'dsh-purge\heal'
$startup = Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs\Startup'
$vbs     = Join-Path $startup 'dsh-purge-heal.vbs'

$tasks = @(
    @{ Name = 'DSH Purge Heal';     Script = 'heal.ps1';      Args = '';        Sc = 'minute'; Mo = 10; Why = 'every 10 min: re-apply 80 patches if asar came back' }
    @{ Name = 'DSH Purge Upstream'; Script = 'upstream.ps1';  Args = '';        Sc = 'hourly'; Mo = 12; Why = 'every 12 h: probe upstream, informational only' }
    @{ Name = 'DSH Self Check';     Script = 'self-check.ps1'; Args = '-Quiet'; Sc = 'hourly'; Mo = 6;  Why = 'every 6 h: 37 checks, writes verdict json' }
)

foreach ($t in $tasks) { $t.Name = $t.Name + $Suffix }

function Invoke-Step([string]$label, [scriptblock]$action) {
    if ($DryRun) {
        Write-Host "[dry-run] $label"
        return
    }
    Write-Host "[run]     $label"
    & $action
}

if ($Remove) {
    foreach ($t in $tasks) {
        Invoke-Step "schtasks /delete $($t.Name)" { schtasks /delete /tn $t.Name /f 2>&1 | Out-Null }
    }
    Invoke-Step "remove $vbs" { Remove-Item $vbs -Force -ErrorAction SilentlyContinue }
    Write-Host 'done.'
    return
}

# --- sanity: the scripts this points at must exist ---------------------------
foreach ($t in $tasks) {
    $p = Join-Path $heal $t.Script
    if (-not (Test-Path $p)) { throw "missing script: $p -- run restore.ps1 first" }
}

# --- scheduled tasks --------------------------------------------------------
foreach ($t in $tasks) {
    $scriptPath = Join-Path $heal $t.Script
    $inner = "-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$scriptPath`""
    if ($t.Args) { $inner = "$inner $($t.Args)" }
    $tr = "powershell.exe $inner"

    $argv = @(
        '/create', '/tn', $t.Name, '/tr', $tr,
        '/sc', $t.Sc, '/mo', "$($t.Mo)", '/f'
    )
    Invoke-Step "schtasks /create $($t.Name)  [$($t.Why)]" {
        $out = & schtasks @argv 2>&1
        if ($LASTEXITCODE -ne 0) { throw "schtasks failed for $($t.Name): $out" }
        $out | Out-Null
    }
}

# --- logon launcher: fill the template, keep it pure ASCII -------------------
$tplPath = Join-Path $PSScriptRoot '..\config\startup\dsh-purge-heal.vbs.tpl'
if (-not (Test-Path $tplPath)) { throw "missing template: $tplPath" }

$tpl = [System.IO.File]::ReadAllText($tplPath)
if ($tpl -notmatch '__HEAL_PS1__') { throw "template lost its __HEAL_PS1__ placeholder" }

$vbsBody = $tpl.Replace('__HEAL_PS1__', (Join-Path $heal 'heal.ps1'))
$nonAscii = ($vbsBody.ToCharArray() | Where-Object { [int]$_ -gt 127 }).Count
if ($nonAscii -gt 0) { throw "rendered .vbs contains $nonAscii non-ASCII chars; cscript would break" }

Invoke-Step "write $vbs" {
    New-Item -ItemType Directory $startup -Force | Out-Null
    [System.IO.File]::WriteAllText($vbs, $vbsBody, (New-Object System.Text.ASCIIEncoding))
}

if (-not $DryRun) {
    Write-Host ''
    Write-Host 'verify with:'
    Write-Host '  schtasks /query /tn "DSH Purge Heal"     /fo LIST | Select-String "Status|Next Run|Last Result"'
    Write-Host '  schtasks /query /tn "DSH Self Check"     /fo LIST | Select-String "Status|Next Run|Last Result"'
    Write-Host '  schtasks /query /tn "DSH Purge Upstream" /fo LIST | Select-String "Status|Next Run|Last Result"'
}
