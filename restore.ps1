# restore.ps1 -- rebuild the three-layer setup of one DSH installation from this repo.
#
# Run it on a machine where DSH is already installed and has been started once
# (so $DSH_HOME and profiles\desktop exist). It is idempotent: every overwritten
# file is backed up first, and it never deletes anything it did not create.
#
# Usage:
#   pwsh -File restore.ps1                      # full restore (asks nothing)
#   pwsh -File restore.ps1 -WhatIfLike          # only report what would change
#   pwsh -File restore.ps1 -SkipPnpm            # skip pnpm install (node_modules already there)
#   pwsh -File restore.ps1 -SkipHeal            # skip re-applying the 80 host patches
#   pwsh -File restore.ps1 -SkipTasks           # skip scheduled task / startup registration
#
# What it does NOT do (deliberate):
#   * never touches .credentials.yaml  -- API keys must be re-entered by hand
#   * never touches sessions\ or AGENTS.md
#   * never downloads anything; the vendored tarball is the only source

[CmdletBinding()]
param(
    [string]$DshHome   = $(if ($env:DSH_HOME) { $env:DSH_HOME } else { Join-Path $env:USERPROFILE '.dsh' }),
    [string]$InstallDir = '',
    [switch]$SkipPnpm,
    [switch]$ForceInstall,
    [switch]$SkipHeal,
    [switch]$SkipTasks,
    [switch]$WhatIfLike
)

$ErrorActionPreference = 'Stop'
$repo = $PSScriptRoot
$purge = Join-Path $DshHome 'dsh-purge'
$profileDir = Join-Path $DshHome 'profiles\desktop'
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'

$problems = New-Object System.Collections.ArrayList
$actions  = New-Object System.Collections.ArrayList

function Say([string]$msg, [string]$kind = 'info') {
    $tag = switch ($kind) { 'ok' { '[ ok ]' } 'skip' { '[skip]' } 'warn' { '[warn]' } 'backup' { '[bak ]' } default { '[ .. ]' } }
    Write-Host "$tag $msg"
}
function Act([string]$desc, [scriptblock]$body) {
    [void]$actions.Add($desc)
    if ($WhatIfLike) { Say "would: $desc"; return }
    & $body
    Say $desc 'ok'
}
function Backup([string]$file) {
    if (Test-Path $file) {
        $bak = "$file.bak-$stamp"
        if (-not $WhatIfLike) { Copy-Item $file $bak -Force }
        Say "backup $file -> $(Split-Path $bak -Leaf)" 'backup'
    }
}

Write-Host ''
Write-Host '=== dsh-purge restore ==='
Write-Host "repo     : $repo"
Write-Host "DSH_HOME : $DshHome"
Write-Host ''

# --- 0. preconditions -------------------------------------------------------
if (-not (Test-Path $DshHome)) {
    throw "DSH_HOME not found: $DshHome -- install DSH and start it once first."
}
if (-not (Test-Path $profileDir)) {
    throw "profile dir not found: $profileDir -- start DSH once so it creates the default profile."
}

if (-not $InstallDir) {
    $keys = @(
        'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*',
        'HKLM:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*',
        'HKLM:\Software\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\*'
    )
    foreach ($k in $keys) {
        $hit = Get-ItemProperty $k -ErrorAction SilentlyContinue |
               Where-Object { $_.DisplayName -like 'DeepSeek Harness*' } | Select-Object -First 1
        if ($hit -and $hit.InstallLocation -and (Test-Path $hit.InstallLocation)) {
            $InstallDir = $hit.InstallLocation; break
        }
        if ($hit -and $hit.UninstallString) {
            $guess = Split-Path ($hit.UninstallString -replace '^"([^"]+)".*$', '$1') -Parent
            if ($guess -and (Test-Path $guess)) { $InstallDir = $guess; break }
        }
    }
}
if ($InstallDir -and (Test-Path $InstallDir)) {
    Say "install dir: $InstallDir"
} else {
    Say "install dir not auto-detected; L2 patch replay will need -InstallDir" 'warn'
    [void]$problems.Add('install dir not detected')
}

$nodeExe = Join-Path $InstallDir 'resources\runtime\primary-runtime\dependencies\node\bin\node.exe'
if (-not (Test-Path $nodeExe)) { $nodeExe = $null; Say 'bundled node.exe not found' 'warn' }

# --- 1. L1: prompt-inject.md ------------------------------------------------
Act 'copy prompt-inject.md -> $DSH_HOME' {
    Backup (Join-Path $DshHome 'prompt-inject.md')
    Copy-Item (Join-Path $repo 'prompt-inject.md') $DshHome -Force
}

# --- 2. state files + toolset -> $DSH_HOME\dsh-purge ------------------------
Act 'create $DSH_HOME\dsh-purge' {
    New-Item -ItemType Directory $purge -Force | Out-Null
}

# Explicit allowlist. A glob like *.ps1 would drag restore.ps1 itself into
# dsh-purge\ and folder-copy the repo onto itself.
$stateNames = @(
    'applied.json', 'drill-grant.json', 'expected-baseline.json', 'installed-rev',
    'override-state.json', 'passthrough.json', 'settle-restart.guard',
    'tuning.json', 'unpacked-asar.json', 'unseal-on-quit.ps1', 'update-status.json'
)
foreach ($name in $stateNames) {
    $src = Join-Path $repo $name
    if (-not (Test-Path $src)) { Say "state  $name (absent in repo, skipped)" 'skip'; continue }
    $dest = Join-Path $purge $name
    Act "state  $name -> dsh-purge\" {
        Backup $dest
        Copy-Item $src $dest -Force
    }
}

foreach ($dir in @('heal', 'vendor')) {
    Act "toolset $dir -> dsh-purge\$dir" {
        $dest = Join-Path $purge $dir
        if (Test-Path $dest) { Backup $dest }   # whole-dir backup, keeps .bak-<ts> copies
        Copy-Item (Join-Path $repo $dir) $purge -Recurse -Force
    }
}

# --- 3. profile config ------------------------------------------------------
Act 'copy cordis.patch.yml -> profiles\desktop' {
    Backup (Join-Path $profileDir 'cordis.patch.yml')
    Copy-Item (Join-Path $repo 'config\cordis.patch.yml') $profileDir -Force
}

Act 'rewrite package.json pins -> vendored tarballs (absolute, forward slashes)' {
    $pkgPath = Join-Path $profileDir 'package.json'
    Backup $pkgPath
    $pkg = [System.IO.File]::ReadAllText((Join-Path $repo 'config\package.json'))

    # dsh-purge-community: the contract anchor, always local.
    $purgeTar = (Join-Path $purge 'vendor\dsh-purge-community-1.6.60.tgz').Replace('\', '/')
    $pkg = [regex]::Replace($pkg,
        '"dsh-purge-community"\s*:\s*"[^"]*"',
        '"dsh-purge-community": "file:' + $purgeTar + '"')
    Say "pin dsh-purge-community -> file:$purgeTar" 'ok'

    # dsh-lang-zh: only dep that would otherwise hit GitHub during install.
    # That makes a clean restore depend on network conditions, which defeats
    # the point of a frozen snapshot. Pin it when the vendored copy exists.
    $langTar = Join-Path $purge 'vendor\dsh-lang-zh-1.0.0.tgz'
    if (Test-Path $langTar) {
        $langUrl = $langTar.Replace('\', '/')
        $pkg = [regex]::Replace($pkg,
            '"dsh-lang-zh"\s*:\s*"[^"]*"',
            '"dsh-lang-zh": "file:' + $langUrl + '"')
        Say "pin dsh-lang-zh          -> file:$langUrl" 'ok'
    } else {
        Say 'dsh-lang-zh stays a git dep (vendored tgz absent) -- install will need GitHub' 'warn'
    }

    [System.IO.File]::WriteAllText($pkgPath, $pkg, (New-Object System.Text.UTF8Encoding($false)))
}

# --- 3b. pnpm lockfile -----------------------------------------------------
# NOT optional. Without it pnpm has to re-resolve the whole graph, and
# @deepseek-ai/* only publish the versions this profile needs under the
# `next`/`alpha` dist-tags -- a plain resolve dies on
#   ERR_PNPM_NO_MATCHING_VERSION ... @deepseek-ai/dsh-client-ui-slots@>=0.2.1 <0.3.0-0
# (registry latest is 0.0.1-rc.1). Keep the lockfile, install frozen.
$lockSrc = Join-Path $repo 'config\pnpm-lock.yaml'
if (Test-Path $lockSrc) {
    Act 'copy pnpm-lock.yaml -> profiles\desktop' {
        Backup (Join-Path $profileDir 'pnpm-lock.yaml')
        Copy-Item $lockSrc $profileDir -Force
    }
} else {
    Say 'pnpm-lock.yaml absent in repo -- install will almost certainly fail' 'warn'
    [void]$problems.Add('no lockfile')
}

# --- 4. pnpm install --------------------------------------------------------
$nm = Join-Path $profileDir 'node_modules'
if ($SkipPnpm) {
    Say 'pnpm install skipped (-SkipPnpm)' 'skip'
} elseif ((Test-Path $nm) -and -not $ForceInstall) {
    Say 'node_modules already present -- leaving it alone (use -ForceInstall to redo)' 'skip'
} else {
    $pnpm = Join-Path $InstallDir 'resources\runtime\primary-runtime\dependencies\pnpm\bin\pnpm.mjs'
    if (-not (Test-Path $pnpm)) {
        Say 'pnpm.mjs not found; run pnpm install in profiles\desktop yourself' 'warn'
        [void]$problems.Add('pnpm missing')
    } elseif (-not $nodeExe) {
        Say 'node.exe missing; cannot run pnpm' 'warn'
        [void]$problems.Add('node missing')
    } else {
        Act 'pnpm install --frozen-lockfile (settings aligned to lockfile)' {
            Push-Location $profileDir
            try {
                $o = & $nodeExe $pnpm install --frozen-lockfile --prefer-offline `
                        --config.autoInstallPeers=false --config.excludeLinksFromLockfile=false 2>&1
                $code = $LASTEXITCODE
                $o | ForEach-Object { Write-Host "       $_" }
                if ($code -ne 0) {
                    Say 'pnpm install failed -- see the remediation notes above' 'warn'
                    Say 'most likely: package.json specifiers drifted from pnpm-lock.yaml.' 'info'
                    Say 'Either copy node_modules from the old profile (fastest, always correct),' 'info'
                    Say 'or align the two files by hand, then rerun with -ForceInstall.' 'info'
                    [void]$problems.Add('pnpm install failed')
                }
            } finally { Pop-Location }
        }
    }
}

# --- 5. L2: replay the host patches ----------------------------------------
if ($SkipHeal) {
    Say 'patch replay skipped (-SkipHeal)' 'skip'
} else {
    $healPs1 = Join-Path $purge 'heal\heal.ps1'
    if (-not (Test-Path $healPs1)) {
        Say 'heal.ps1 missing' 'warn'
    } else {
        Say 'next step needs DSH closed. Close the app, then run:' 'info'
        Say "  powershell -NoProfile -ExecutionPolicy Bypass -File `"$healPs1`" -Wait -Start" 'info'
        [void]$actions.Add('manual: heal.ps1 -Wait -Start')
    }
}

# --- 6. watchdog tasks + logon launcher ------------------------------------
if ($SkipTasks) {
    Say 'task registration skipped (-SkipTasks)' 'skip'
} else {
    Act 'register scheduled tasks + startup launcher' {
        & (Join-Path $repo 'install\register-tasks.ps1') -DshHome $DshHome
    }
}

# --- 7. verify --------------------------------------------------------------
Write-Host ''
Write-Host '=== verify ==='
if ($nodeExe) {
    $selfCheck = Join-Path $purge 'heal\self-check.mjs'
    $resolver  = Join-Path $purge 'heal\resolver.mjs'
    if ($WhatIfLike) {
        Say 'would: node self-check.mjs'
    } elseif (Test-Path $selfCheck) {
        & $nodeExe $selfCheck 2>&1 | Select-Object -Last 25 | ForEach-Object { Write-Host "       $_" }
    }
    if ((-not $WhatIfLike) -and (Test-Path $resolver)) {
        Write-Host '--- resolver doctor ---'
        Push-Location (Join-Path $purge 'heal')
        try { & $nodeExe $resolver doctor 2>&1 | ForEach-Object { Write-Host "       $_" } }
        finally { Pop-Location }
    }
} else {
    Say 'skipping verification: no node.exe' 'warn'
}

Write-Host ''
Write-Host "actions: $($actions.Count)"
if ($problems.Count) {
    Write-Host "problems: $($problems -join '; ')"
} else {
    Write-Host 'problems: none'
}
Write-Host ''
Write-Host 'Still manual, by design:'
Write-Host '  1. re-enter API keys in the Models page (or .credentials.yaml)'
Write-Host '  2. copy your own AGENTS.md if you had one'
Write-Host '  3. restart DSH so cordis.patch.yml takes effect'
