# Start the Proving Grounds table (Vite on 5173) and the advisory judge proxy
# (5174, Claude Code driver) in two consoles, wait for both to answer, then
# open the table in the default browser.
#
#   npm run play
#   powershell -ExecutionPolicy Bypass -File scripts/play.ps1

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$devUrl = 'http://localhost:5173/'
$healthUrl = 'http://127.0.0.1:5174/api/judge/health'

function Test-Port([int]$port) {
  return [bool](Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue)
}

function Start-Console([string]$title, [string]$command) {
  $inner = "`$Host.UI.RawUI.WindowTitle = '$title'; Set-Location '$root'; $command"
  Start-Process powershell -ArgumentList '-NoExit', '-ExecutionPolicy', 'Bypass', '-Command', $inner | Out-Null
}

if (Test-Port 5174) {
  Write-Host 'judge: already listening on 5174, leaving it alone'
} else {
  Start-Console 'Proving Grounds - judge' "`$env:JUDGE_DRIVER = 'claude-code'; npm run judge"
  Write-Host 'judge: starting (JUDGE_DRIVER=claude-code)'
}

if (Test-Port 5173) {
  Write-Host 'table: already listening on 5173, leaving it alone'
} else {
  Start-Console 'Proving Grounds - table' 'npm run dev'
  Write-Host 'table: starting'
}

function Wait-Until([string]$label, [scriptblock]$probe, [int]$seconds = 60) {
  $deadline = (Get-Date).AddSeconds($seconds)
  while ((Get-Date) -lt $deadline) {
    try { $r = & $probe; if ($null -ne $r) { return $r } } catch {}
    Start-Sleep -Milliseconds 500
  }
  Write-Host "$label did not answer within $seconds s; check its console window."
  return $null
}

$table = Wait-Until 'table' { Invoke-WebRequest -UseBasicParsing -Uri $devUrl -TimeoutSec 2 }
if ($table) { Write-Host "table: up at $devUrl" }

$health = Wait-Until 'judge' { Invoke-RestMethod -Uri $healthUrl -TimeoutSec 2 }
if ($health) {
  if ($health.ok) {
    Write-Host "judge: ready (corpus $($health.corpusDate))"
  } else {
    Write-Host "judge: answering but not usable yet (hasKey=$($health.hasKey), corpus=$($health.corpusDate))."
    Write-Host '       For the claude-code driver, run /login once in the bundled claude.exe if hasKey is False.'
  }
}

if ($table) { Start-Process $devUrl }
Write-Host 'Press J at the table to open the judge drawer. Close the two console windows to stop.'
