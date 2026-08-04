#Requires -Version 5.1
<#
.SYNOPSIS
  Install MT-Billing on Windows (Node.js + WinSW Windows service).

.DESCRIPTION
  Downloads/clones MT-Billing, builds the panel, and registers a Windows service
  that serves both the API and the web UI on one port (default 80).

  Run elevated (Administrator):
    powershell -ExecutionPolicy Bypass -File .\install.ps1

.PARAMETER InstallDir
  Application files (default: C:\Program Files\MT-Billing)

.PARAMETER DataDir
  SQLite + secrets (default: C:\ProgramData\MT-Billing)

.PARAMETER Port
  Listen port for UI + API (default: 80)

.PARAMETER RepoUrl
  Git clone URL or zip URL of the source (default: public GitHub zip of main)

.PARAMETER Branch
  Git branch when cloning (default: main)

.PARAMETER SkipService
  Build only; do not install/start the Windows service
#>
[CmdletBinding()]
param(
  [string]$InstallDir = 'C:\Program Files\MT-Billing',
  [string]$DataDir = 'C:\ProgramData\MT-Billing',
  [int]$Port = 80,
  [string]$RepoUrl = 'https://github.com/tsogs66/MT-Billing/archive/refs/heads/main.zip',
  [string]$Branch = 'main',
  [string]$AdminUser = 'admin',
  [string]$AdminPass = 'admin123',
  [switch]$SkipService,
  [switch]$UseGit
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

function Assert-Admin {
  $id = [Security.Principal.WindowsIdentity]::GetCurrent()
  $principal = New-Object Security.Principal.WindowsPrincipal($id)
  if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    throw 'Run this script as Administrator (right-click PowerShell → Run as administrator).'
  }
}

function Write-Step([string]$msg) {
  Write-Host ""
  Write-Host "==> $msg" -ForegroundColor Cyan
}

function Ensure-Dir([string]$path) {
  if (-not (Test-Path -LiteralPath $path)) {
    New-Item -ItemType Directory -Path $path -Force | Out-Null
  }
}

function Get-NodeMajor {
  try {
    $v = & node -v 2>$null
    if ($v -match 'v(\d+)') { return [int]$Matches[1] }
  } catch {}
  return 0
}

function Ensure-Node {
  $major = Get-NodeMajor
  if ($major -ge 20) {
    Write-Host "Node.js $(node -v) OK"
    return
  }

  Write-Step "Installing Node.js 22 LTS (winget)"
  $winget = Get-Command winget -ErrorAction SilentlyContinue
  if ($winget) {
    & winget install -e --id OpenJS.NodeJS.LTS --accept-package-agreements --accept-source-agreements
    $env:Path = [System.Environment]::GetEnvironmentVariable('Path', 'Machine') + ';' +
      [System.Environment]::GetEnvironmentVariable('Path', 'User')
    $major = Get-NodeMajor
    if ($major -ge 20) {
      Write-Host "Node.js $(node -v) installed"
      return
    }
  }

  Write-Step "Downloading portable Node.js 22 (x64)"
  $nodeVer = 'v22.14.0'
  $zipName = "node-$nodeVer-win-x64.zip"
  $url = "https://nodejs.org/dist/$nodeVer/$zipName"
  $tmp = Join-Path $env:TEMP $zipName
  $runtime = Join-Path $InstallDir 'runtime'
  Ensure-Dir $InstallDir
  Invoke-WebRequest -Uri $url -OutFile $tmp
  if (Test-Path $runtime) { Remove-Item -Recurse -Force $runtime }
  Expand-Archive -Path $tmp -DestinationPath $InstallDir -Force
  $extracted = Join-Path $InstallDir "node-$nodeVer-win-x64"
  if (Test-Path $extracted) {
    Rename-Item -Path $extracted -NewName 'runtime'
  }
  $nodeBin = Join-Path $runtime 'node.exe'
  if (-not (Test-Path $nodeBin)) { throw "Portable Node extract failed: $runtime" }
  $env:Path = "$runtime;$env:Path"
  Write-Host "Using portable Node $($(& $nodeBin -v))"
}

function Get-NodeCmd {
  $portable = Join-Path $InstallDir 'runtime\node.exe'
  if (Test-Path $portable) { return $portable }
  return 'node'
}

function Get-NpmCmd {
  $portableNpm = Join-Path $InstallDir 'runtime\npm.cmd'
  if (Test-Path $portableNpm) { return $portableNpm }
  return 'npm'
}

function Install-Source {
  Write-Step "Installing application into $InstallDir"
  Ensure-Dir $InstallDir

  $marker = Join-Path $InstallDir 'package.json'
  if ((Test-Path $marker) -and (Test-Path (Join-Path $InstallDir 'server'))) {
    Write-Host "Existing install found — updating sources…"
  }

  if ($UseGit -or ($RepoUrl -match '\.git$')) {
    $git = Get-Command git -ErrorAction SilentlyContinue
    if (-not $git) { throw 'Git is required when -UseGit is set. Install Git for Windows or omit -UseGit.' }
    $cloneUrl = if ($RepoUrl -match '\.git$') { $RepoUrl } else { 'https://github.com/tsogs66/MT-Billing.git' }
    if (Test-Path (Join-Path $InstallDir '.git')) {
      Push-Location $InstallDir
      try {
        & git fetch origin
        & git checkout $Branch
        & git pull --ff-only origin $Branch
      } finally { Pop-Location }
    } else {
      Ensure-Dir (Split-Path $InstallDir -Parent)
      if (Test-Path $InstallDir) {
        Get-ChildItem -LiteralPath $InstallDir -Force |
          Where-Object { $_.Name -ne 'runtime' -and $_.Name -ne 'service' } |
          Remove-Item -Recurse -Force -ErrorAction SilentlyContinue
      }
      & git clone --branch $Branch --depth 1 $cloneUrl $InstallDir
    }
    return
  }

  $zipPath = Join-Path $env:TEMP 'mt-billing-src.zip'
  Write-Host "Downloading $RepoUrl"
  Invoke-WebRequest -Uri $RepoUrl -OutFile $zipPath
  $extractRoot = Join-Path $env:TEMP ("mt-billing-extract-" + [guid]::NewGuid().ToString('n'))
  Ensure-Dir $extractRoot
  Expand-Archive -Path $zipPath -DestinationPath $extractRoot -Force
  $inner = Get-ChildItem -LiteralPath $extractRoot -Directory | Select-Object -First 1
  if (-not $inner) { throw 'Zip archive had no top-level folder' }

  Ensure-Dir $InstallDir
  # Preserve portable runtime / service binaries across refresh
  $keep = @('runtime', 'service')
  Get-ChildItem -LiteralPath $InstallDir -Force -ErrorAction SilentlyContinue |
    Where-Object { $keep -notcontains $_.Name } |
    Remove-Item -Recurse -Force -ErrorAction SilentlyContinue

  Copy-Item -Path (Join-Path $inner.FullName '*') -Destination $InstallDir -Recurse -Force
  Remove-Item -Recurse -Force $extractRoot -ErrorAction SilentlyContinue
}

function Write-EnvFile {
  Write-Step "Writing server\.env"
  Ensure-Dir $DataDir
  Ensure-Dir (Join-Path $DataDir 'backups')
  $jwt = -join ((1..48) | ForEach-Object { '{0:x2}' -f (Get-Random -Maximum 256) })
  $envPath = Join-Path $InstallDir 'server\.env'
  @"
PORT=$Port
SERVE_STATIC=1
MT_DATA_DIR=$DataDir
JWT_SECRET=$jwt
ADMIN_USER=$AdminUser
ADMIN_PASS=$AdminPass
"@ | Set-Content -Path $envPath -Encoding UTF8
  Write-Host "Data directory: $DataDir"
}

function Build-App {
  Write-Step "npm install + build (this can take several minutes)"
  $npm = Get-NpmCmd
  Push-Location $InstallDir
  try {
    & $npm install
    if ($LASTEXITCODE -ne 0) { throw "npm install failed ($LASTEXITCODE)" }
    & $npm run build
    if ($LASTEXITCODE -ne 0) { throw "client build failed ($LASTEXITCODE)" }
    & $npm --prefix server run build
    if ($LASTEXITCODE -ne 0) { throw "server build failed ($LASTEXITCODE)" }
  } finally {
    Pop-Location
  }
}

function Install-WinSW {
  Write-Step "Installing WinSW Windows service"
  $svcDir = Join-Path $InstallDir 'service'
  Ensure-Dir $svcDir
  $exe = Join-Path $svcDir 'MTBillingAPI.exe'
  $xml = Join-Path $svcDir 'MTBillingAPI.xml'

  if (-not (Test-Path $exe)) {
    $winswUrl = 'https://github.com/winsw/winsw/releases/download/v2.12.0/WinSW-x64.exe'
    Write-Host "Downloading WinSW…"
    Invoke-WebRequest -Uri $winswUrl -OutFile $exe
  }

  $nodeExe = Get-NodeCmd
  if ($nodeExe -eq 'node') {
    $nodeExe = (Get-Command node).Source
  }
  $workDir = Join-Path $InstallDir 'server'
  $logDir = Join-Path $DataDir 'logs'
  Ensure-Dir $logDir

  @"
<service>
  <id>MTBillingAPI</id>
  <name>MT-Billing API</name>
  <description>MT-Billing MikroTik billing panel (API + web UI)</description>
  <executable>$nodeExe</executable>
  <arguments>"$workDir\dist\index.js"</arguments>
  <workingdirectory>$workDir</workingdirectory>
  <logpath>$logDir</logpath>
  <log mode="roll-by-size">
    <sizeThreshold>10240</sizeThreshold>
    <keepFiles>8</keepFiles>
  </log>
  <onfailure action="restart" delay="5 sec"/>
  <onfailure action="restart" delay="10 sec"/>
  <resetfailure>1 hour</resetfailure>
  <env name="NODE_ENV" value="production"/>
</service>
"@ | Set-Content -Path $xml -Encoding UTF8

  # Stop/uninstall previous service if present
  $existing = Get-Service -Name 'MTBillingAPI' -ErrorAction SilentlyContinue
  if ($existing) {
    & $exe stop 2>$null
    Start-Sleep -Seconds 2
    & $exe uninstall 2>$null
    Start-Sleep -Seconds 1
  }

  & $exe install
  if ($LASTEXITCODE -ne 0) { throw "WinSW install failed ($LASTEXITCODE)" }
  & $exe start
  if ($LASTEXITCODE -ne 0) { throw "WinSW start failed ($LASTEXITCODE)" }
  Write-Host "Service MTBillingAPI installed and started"
}

function Set-FirewallRule {
  Write-Step "Firewall rule for TCP $Port"
  $name = 'MT-Billing Panel'
  Get-NetFirewallRule -DisplayName $name -ErrorAction SilentlyContinue | Remove-NetFirewallRule -ErrorAction SilentlyContinue
  New-NetFirewallRule -DisplayName $name -Direction Inbound -Action Allow -Protocol TCP -LocalPort $Port | Out-Null
}

function Write-Shortcuts {
  Write-Step "Start Menu / desktop helpers"
  $startConsole = Join-Path $InstallDir 'install\windows\start-console.bat'
  if (-not (Test-Path $startConsole)) {
    $startConsole = Join-Path $InstallDir 'start-console.bat'
  }
  $programs = Join-Path $env:ProgramData 'Microsoft\Windows\Start Menu\Programs\MT-Billing'
  Ensure-Dir $programs
  $url = "http://127.0.0.1:$Port/"
  $shortcutPath = Join-Path $programs 'MT-Billing Panel.url'
  @"
[InternetShortcut]
URL=$url
"@ | Set-Content -Path $shortcutPath -Encoding ASCII

  $uninstallCmd = Join-Path $InstallDir 'install\windows\uninstall.ps1'
  if (Test-Path $uninstallCmd) {
    @"
@echo off
powershell -ExecutionPolicy Bypass -File "$uninstallCmd"
"@ | Set-Content -Path (Join-Path $programs 'Uninstall MT-Billing.cmd') -Encoding ASCII
  }
}

# ---- main ----
Assert-Admin
Write-Host "MT-Billing Windows installer" -ForegroundColor Green
Write-Host "InstallDir=$InstallDir  DataDir=$DataDir  Port=$Port"

Ensure-Node
Install-Source
Write-EnvFile
Build-App

# Copy this installer pack into the tree if we were run from a release zip outside the tree
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$destWin = Join-Path $InstallDir 'install\windows'
Ensure-Dir $destWin
Copy-Item -Path (Join-Path $here '*') -Destination $destWin -Force -ErrorAction SilentlyContinue

if (-not $SkipService) {
  Install-WinSW
  Set-FirewallRule
}
Write-Shortcuts

Write-Host ""
Write-Host "Installation complete." -ForegroundColor Green
Write-Host "Open http://127.0.0.1:$Port/  (login: $AdminUser / $AdminPass)"
Write-Host "Change the default password after first sign-in."
Write-Host "Service: MTBillingAPI  |  Logs: $DataDir\logs  |  Data: $DataDir"
Write-Host "Uninstall: powershell -ExecutionPolicy Bypass -File `"$InstallDir\install\windows\uninstall.ps1`""
