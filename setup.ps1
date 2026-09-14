# Auto-generates .env for this machine — detects which of Claude Code,
# Codex CLI, Gemini CLI, and Antigravity are actually installed (by
# checking for their config directories under your user profile) and
# writes only those into .env. Safe to re-run any time; it overwrites .env
# with a fresh detection.
#
# Usage (from the repo root, in PowerShell):
#   .\setup.ps1
#
# On Mac/Linux/WSL/Git Bash, use ./setup.sh instead.

$ErrorActionPreference = 'Stop'
$homeDir = $env:USERPROFILE
if (-not $homeDir) {
    Write-Error "Could not determine your home directory (`$env:USERPROFILE is unset)."
    exit 1
}

$envFile = Join-Path $PSScriptRoot ".env"
$lines = @()
$foundAny = $false

function Test-Agent {
    param([string]$Name, [string]$Dir, [string]$VarName)
    if (Test-Path $Dir -PathType Container) {
        $dockerPath = $Dir -replace '\\', '/'
        Write-Host "  found $Name -> $dockerPath"
        $script:lines += "$VarName=$dockerPath"
        $script:foundAny = $true
    } else {
        Write-Host "  $Name not found (looked for $Dir) - skipping"
    }
}

Write-Host "Detecting installed AI CLI agents under $homeDir ..."
Test-Agent -Name "Claude Code" -Dir (Join-Path $homeDir ".claude")                     -VarName "CLAUDE_HOME_DIR"
Test-Agent -Name "Codex CLI"   -Dir (Join-Path $homeDir ".codex")                      -VarName "CODEX_HOME_DIR"
Test-Agent -Name "Gemini CLI"  -Dir (Join-Path $homeDir ".gemini")                     -VarName "GEMINI_HOME_DIR"
Test-Agent -Name "Antigravity" -Dir (Join-Path $homeDir ".gemini\antigravity-cli")     -VarName "ANTIGRAVITY_HOME_DIR"

if (-not $foundAny) {
    Write-Host ""
    Write-Warning "No agent config directories found. Claude Brain will still start (with nothing to show) - install and use one of Claude Code / Codex CLI / Gemini CLI / Antigravity at least once, then re-run this script."
}

$lines | Set-Content -Path $envFile -Encoding utf8

Write-Host ""
Write-Host "Wrote $envFile:"
Get-Content $envFile | ForEach-Object { Write-Host "  $_" }
Write-Host ""
Write-Host "Next: docker compose up -d --build"
