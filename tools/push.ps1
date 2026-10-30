# push.ps1 -- push this repo to GitHub despite the local network oddities.
#
# Three real problems on this machine, all solved here:
#   1. Global git rewrite  url.https://gh-proxy.com/https://github.com/.insteadOf = https://github.com/
#      rewrites every github.com URL to a public read-only mirror; authenticated
#      push dies. Fix: run with a throwaway GIT_CONFIG_GLOBAL that has no rewrite.
#   2. Direct TCP 443 to github.com is intermittent, and git ignores the system
#      proxy setting. Fix: explicit -c http.proxy / -c https.proxy.
#   3. The token must never land in .git/config. Fix: one-shot http.extraheader,
#      built in memory, never written to disk.
#
# Usage:
#   $env:GITHUB_TOKEN = 'ghp_xxx'
#   pwsh -File tools\push.ps1
#   pwsh -File tools\push.ps1 -Token ghp_xxx -Proxy http://127.0.0.1:7890
#
# Needs the `repo` scope on the token.

[CmdletBinding()]
param(
    [string]$Token  = $env:GITHUB_TOKEN,
    [string]$User   = 'huapingwang63-cmyk',
    [string]$Repo   = 'dsh-purge-local',
    [string]$Proxy  = 'http://127.0.0.1:7890',
    [string]$Branch = 'main'
)

$ErrorActionPreference = 'Stop'

if ([string]::IsNullOrWhiteSpace($Token)) {
    throw 'No token. Set $env:GITHUB_TOKEN or pass -Token.'
}

$root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
Push-Location $root

# --- neutralise the gh-proxy rewrite with a throwaway global config ---------
$tmp = Join-Path ([System.IO.Path]::GetTempPath()) ("git-push-" + [guid]::NewGuid().ToString('N') + ".cfg")
$cfg = "[user]`n`tname = Wang`n`temail = huapingwang63@gmail.com`n"
[System.IO.File]::WriteAllText($tmp, $cfg, (New-Object System.Text.UTF8Encoding($false)))
$env:GIT_CONFIG_GLOBAL = $tmp
$env:GIT_TERMINAL_PROMPT = '0'

$b64 = [Convert]::ToBase64String([Text.Encoding]::ASCII.GetBytes(($User + ':' + $Token)))
$header = 'AUTHORIZATION: basic ' + $b64

# Build the argument list explicitly. -c MUST precede the subcommand.
$gitArgs = @(
    '-c', 'credential.helper='
    '-c', ('http.https://github.com/.extraheader=' + $header)
    '-c', ('http.proxy=' + $Proxy)
    '-c', ('https.proxy=' + $Proxy)
    '-c', 'http.version=HTTP/1.1'
    '-c', 'http.postBuffer=524288000'
)

function Show([string[]]$lines) {
    foreach ($l in $lines) {
        $s = $l.Replace($Token, '<TOKEN_REDACTED>').Replace($b64, '<B64_REDACTED>')
        Write-Host $s
    }
}

try {
    Write-Host "remote : https://github.com/$User/$Repo.git"
    Write-Host "branch : $Branch"
    Write-Host "proxy  : $Proxy"

    $url = "https://github.com/$User/$Repo.git"
    if (git remote get-url origin 2>$null) {
        git remote set-url origin $url 2>&1 | Out-Null
    } else {
        git remote add origin $url 2>&1 | Out-Null
    }

    # prove the header really took effect before pushing
    $probe = & git @gitArgs config --get 'http.https://github.com/.extraheader' 2>&1
    if (-not ($probe -like 'AUTHORIZATION: basic *')) {
        throw "auth header not applied; git returned: $probe"
    }
    Write-Host 'auth header : applied'

    $out = & git @gitArgs push -u origin $Branch 2>&1
    $code = $LASTEXITCODE
    Show $out
    if ($code -ne 0) { throw "push failed with exit code $code" }
    Write-Host 'push OK'
}
finally {
    Pop-Location
    Remove-Item $tmp -Force -ErrorAction SilentlyContinue
    Remove-Item Env:\GIT_CONFIG_GLOBAL -ErrorAction SilentlyContinue
    Remove-Item Env:\GIT_TERMINAL_PROMPT -ErrorAction SilentlyContinue
}
