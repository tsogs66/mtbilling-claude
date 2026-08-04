#Requires -Version 5.1
<#
.SYNOPSIS
  Uninstall MT-Billing Windows service and optional application files.
#>
[CmdletBinding()]
param(
  [string]$InstallDir = 'C:\Program Files\MT-Billing',
  [switch]$RemoveData,
  [string]$DataDir = 'C:\ProgramData\MT-Billing',
  [switch]$KeepFiles
)

$ErrorActionPreference = 'Stop'

function Assert-Admin {
  $id = [Security.Principal.WindowsIdentity]::GetCurrent()
  $principal = New-Object Security.Principal.WindowsPrincipal($id)
  if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    throw 'Run this script as Administrator.'
  }
}

Assert-Admin

$exe = Join-Path $InstallDir 'service\MTBillingAPI.exe'
if (Test-Path $exe) {
  Write-Host "Stopping service..."
  & $exe stop 2>$null
  Start-Sleep -Seconds 2
  & $exe uninstall 2>$null
} else {
  $svc = Get-Service -Name 'MTBillingAPI' -ErrorAction SilentlyContinue
  if ($svc) {
    Stop-Service MTBillingAPI -Force -ErrorAction SilentlyContinue
    sc.exe delete MTBillingAPI | Out-Null
  }
}

Get-NetFirewallRule -DisplayName 'MT-Billing Panel' -ErrorAction SilentlyContinue |
  Remove-NetFirewallRule -ErrorAction SilentlyContinue

$programs = Join-Path $env:ProgramData 'Microsoft\Windows\Start Menu\Programs\MT-Billing'
if (Test-Path $programs) { Remove-Item -Recurse -Force $programs }

if (-not $KeepFiles -and (Test-Path $InstallDir)) {
  Write-Host "Removing $InstallDir"
  Remove-Item -Recurse -Force $InstallDir
}

if ($RemoveData -and (Test-Path $DataDir)) {
  Write-Host "Removing data $DataDir"
  Remove-Item -Recurse -Force $DataDir
} elseif (Test-Path $DataDir) {
  Write-Host "Data kept at $DataDir (pass -RemoveData to delete SQLite + logs)"
}

Write-Host "Uninstall finished." -ForegroundColor Green
