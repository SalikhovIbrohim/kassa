#Requires -Version 5.1
<#
.SYNOPSIS
  Builds Kassa and applies the database migrations: one command, from a fresh clone or an updated one.

.DESCRIPTION
  npm ci, then npm run build (server and web), then the migrations of the database named in the
  settings file. The server applies migrations when it starts as well; doing it here lets a
  broken migration stop an update before the new version is started.

.PARAMETER Root
  The folder with config, logs and tools. Default C:\kassa.

.PARAMETER NoInstall
  Skip `npm ci` (the packages are installed already).
#>
[CmdletBinding()]
param(
    [string]$Root = 'C:\kassa',
    [switch]$NoInstall
)

. "$PSScriptRoot\common.ps1"

Invoke-Main {
    $layout = Get-KassaLayout -Root $Root
    Assert-Node
    if (-not (Test-Path -LiteralPath $layout.Settings)) {
        throw "The settings file $($layout.Settings) does not exist. Run setup.ps1 first (it creates the database and this file)."
    }

    Push-Location $layout.App
    try {
        if (-not $NoInstall) {
            Write-Step 'Installing packages (npm ci)'
            Invoke-Npm -Arguments @('ci')
        }

        Write-Step 'Building the server and the web app'
        Invoke-Npm -Arguments @('run', 'build')

        Write-Step 'Applying database migrations'
        Invoke-Native -File 'node' -Arguments @("--env-file=$($layout.Settings)", 'server/dist/admin/cli.js', 'migrate')
    }
    finally {
        Pop-Location
    }

    Write-Host ''
    Write-Host 'Built, and the database is up to date.' -ForegroundColor Green
}
