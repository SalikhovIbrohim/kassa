#Requires -Version 5.1
<#
.SYNOPSIS
  First-time setup on a new machine: folders, the database and its settings file, then the first build.

.DESCRIPTION
  Needs Node.js 22, Git (this repository is already cloned, since this script is in it) and a running
  PostgreSQL 16. It asks for the password of the PostgreSQL administrator ("postgres", chosen when
  PostgreSQL was installed), creates a role and a database for Kassa, writes the settings file with a
  generated password, and runs build.ps1. Safe to run again: what exists is kept.

.PARAMETER Root
  The folder with config, logs and tools. Default C:\kassa.
#>
[CmdletBinding()]
param(
    [string]$Root = 'C:\kassa'
)

. "$PSScriptRoot\common.ps1"

Invoke-Main {
    Assert-Administrator
    $layout = Get-KassaLayout -Root $Root
    Assert-Node
    Assert-Tool -Name git -Hint 'Install Git for Windows from https://git-scm.com, then open a new PowerShell window.'
    $postgres = Get-Service -Name 'postgresql*' -ErrorAction SilentlyContinue
    if (-not $postgres) {
        throw 'No PostgreSQL service found. Install PostgreSQL 16 (https://www.postgresql.org/download/windows/) first.'
    }

    Write-Step "Creating folders under $($layout.Root)"
    foreach ($folder in @($layout.Config, $layout.Logs, $layout.Services, $layout.Tools, $layout.CaddyData)) {
        New-Item -ItemType Directory -Force -Path $folder | Out-Null
    }

    Push-Location $layout.App
    try {
        Write-Step 'Installing packages (npm ci)'
        Invoke-Npm -Arguments @('ci')

        Write-Step 'Preparing the database'
        $secret = Read-Host -AsSecureString 'Password of the PostgreSQL user "postgres"'
        $bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secret)
        try { $env:PGPASSWORD = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr) }
        finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr) }
        try {
            Invoke-Native -File 'node' -Arguments @('deploy/setup-database.mjs', '--settings', $layout.Settings)
        }
        finally {
            Remove-Item Env:\PGPASSWORD -ErrorAction SilentlyContinue
        }
    }
    finally {
        Pop-Location
    }

    # The file holds the database password: administrators and the system only. install-services.ps1
    # adds the account the services run as.
    Write-Step 'Restricting the settings file'
    Invoke-Native -File 'icacls.exe' -Arguments @($layout.Settings, '/inheritance:r', '/grant:r', 'SYSTEM:(R)', 'BUILTIN\Administrators:(F)')

    & "$PSScriptRoot\build.ps1" -Root $Root -NoInstall
    if ($LASTEXITCODE -ne 0) { throw 'The build failed (see above).' }

    Write-Host ''
    Write-Host 'Done. Next: create the users (kassa.ps1 create-user ...), then install-services.ps1.' -ForegroundColor Green
}
