# push.ps1 -- push this repo to GitHub despite the local network oddities.
#
# Why this script exists (all three problems are real on this machine):
#   1. A global git rewrite  url.https://gh-proxy.com/https://github.com/.insteadOf = https://github.com/
#      turns every github.com URL into a gh-proxy mirror URL. That mirror only
#      serves public read traffic, so authenticated push fails.
#      Fix: run git with a throwaway GIT_CONFIG_GLOBAL that has no rewrite rule.
#   2. Direct TCP 443 to github.com is intermittent ("Connection was reset",
#      "Could not connect ... after 21s"). The local HTTP proxy does NOT help
#      unless it is passed explicitly.
#      Fix: -c http.proxy / -c https.proxy.
#   3. The token must never land in .git/config.
#      Fix: pass it as a one-shot http.extraheader, never as a remote URL.
#
# Usage:
#   $env:GITHUB_TOKEN = 'ghp_xxx'
#   powershell -File tools\push.ps1
#   powershell -File tools\push.ps1 -Token ghp_xxx -Proxy http://127.0.0.1:7890
#
# The token needs the `repo` scope for a private repository.

[CmdletBinding()]
param(
    [string]$Token = $env:GITHUB_TOKEN,
    [string]$User  = 'huapingwang63-cmyk',
    [string]$Repo  = 'dsh-purge-local',
    [string]$Proxy = 'http://127.0.0.1:7890',
    [string]$Branch = 'main'
)

$ErrorActionPreference = 'Stop'

if ([string]::IsNullOrWhiteSpace($Token)) {
    throw 'No token. Set $env:GITHUB_TOKEN or pass -Token.'
}

# repo root = parent of this script's folder
$root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
Set-Location $root

# --- neutralise the gh-proxy rewrite with a throwaway global config ---------
$tmp = Join-Path ([System.IO.Path]::GetTempPath()) ("git-push-" + [guid]::NewGuid().ToString('N') + ".cfg")
$cfg = "[user]`n`tname = Wang`n`temail = huapingwang63@gmail.com`n[credential]`n`thelper =`n"
[System.IO.File]::WriteAllText($tmp, $cfg, (New-Object System.Text.UTF8Encoding($false)))
$env:GIT_CONFIG_GLOBAL = $tmp
$env:GIT_TERMINAL_PROMPT = '0'

# --- auth header, built in memory only -------------------------------------
$b64 = [Convert]::ToBase64String([Text.Encoding]::ASCII.GetBytes("${User}:${Token}"))

try {
    Write-Host "remote : https://github.com/$User/$Repo.git"
    Write-Host "branch : $Branch"
    Write-Host "proxy  : $Proxy"

    if (-not (git remote get-url origin 2>$null)) {
        git remote add origin "https://github.com/$User/$Repo.git"
    } else {
        git remote set-url origin "https://github.com/$User/$Repo.git"
    }

    $out = git `
        -c credential.helper= `
        -c "http.https://github.com/.extraheader=AUTHORIZATION: basic $b64" `
        -c "http.proxy=$Proxy" `
        -c "https.proxy=$Proxy" `
        -c http.version=HTTP/1.1 `
        -c http.postBuffer=524288000 `
        push -u origin $Branch 2>&1

    $code = $LASTEXITCODE
    $out | ForEach-Object {
        ($_ -replace [regex]::Escape($Token), '<REDACTED>') -replace [regex]::Escape($b64), '<REDACTED>'
    } | Write-Host

    if ($code -ne 0) { throw "push failed with exit code $code" }
    Write-Host 'push OK'
}
finally {
    Remove-Item $tmp -Force -ErrorAction SilentlyContinue
    Remove-Item Env:\GIT_CONFIG_GLOBAL -ErrorAction SilentlyContinue
    Remove-Item Env:\GIT_TERMINAL_PROMPT -ErrorAction SilentlyContinue
}
