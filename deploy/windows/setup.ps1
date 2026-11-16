#Requires -Version 5.1
<#
.SYNOPSIS
  First-time setup on a new machine: folders, the database and its settings file, then the first build.

.DESCRIPTION
  Needs Node.js 22, Git (this repository is already cloned, since this script is in it) and a running
  PostgreSQL 16. It makes the folders under C:\kassa (only the system and the administrators may use
  them), asks for the password of the PostgreSQL administrator ("postgres", chosen when PostgreSQL was
  installed), creates a role and a database for Kassa, writes the settings file with a generated
  password, and runs build.ps1. Safe to run again: what exists is kept.

  If PGPASSWORD is set in the window, that password is used and nothing is asked.

  Another installation on the same machine (the cash desk of another company) is made from its own copy of this
  repository, in the folder "app" of its own root, with a name and a port of its own:
    C:\kassa-express\app\deploy\windows\setup.ps1 -Root C:\kassa-express -Instance express -Port 3001
  It gets its own role and database (kassa_express), and the scripts name its service and its tasks after it
  (KassaApp-express, "Kassa backup (express)"). It shares nothing with the first installation but the machine.

.PARAMETER Root
  The folder with config, logs and tools. Default C:\kassa.

.PARAMETER Instance
  The name of another installation on this machine: one short lower-case word of letters and digits, like express.
  Not given for the first installation.

.PARAMETER Port
  The port the application listens on, written into a new settings file (default 3000). Needed with -Instance:
  every installation on a machine has a port of its own.
#>
[CmdletBinding(PositionalBinding = $false)]
param(
    [string]$Root = 'C:\kassa',
    [string]$Instance,
    [int]$Port = 0
)

. "$PSScriptRoot\common.ps1"

Invoke-Main {
    Assert-Administrator
    $layout = Get-KassaLayout -Root $Root -Instance $Instance
    # Before anything is made: an installation without a name must not take the names of the one that is there
    # (its service, its task, and its database role, whose password would be set anew).
    Assert-OwnService -Layout $layout -Name $layout.AppService
    Assert-Node
    Assert-Tool -Name git -Hint 'Install Git for Windows from https://git-scm.com, then open a new PowerShell window.'
    if ($Port -lt 0 -or $Port -gt 65535) { throw "-Port must be a port number, like 3001, got $Port." }
    if ($layout.Instance -and $Port -eq 0 -and -not (Test-Path -LiteralPath $layout.Settings)) {
        throw 'Another installation on this machine needs a port of its own (the first one listens on 3000): add -Port 3001, or another port that is free.'
    }
    # npm ci below deletes the packages the application runs from: not while it is running (an update is update.ps1).
    $application = Get-ServiceOrNull -Name $layout.AppService
    if ($application -and $application.Status -ne 'Stopped') {
        throw "The service $($layout.AppService) is running, and this script reinstalls the packages it runs from. For a new version use update.ps1. To run this anyway, stop the service first: Stop-Service $($layout.AppService)"
    }
    $postgres = @(Get-Service -Name 'postgresql*' -ErrorAction SilentlyContinue)
    if ($postgres.Count -eq 0) {
        throw 'No PostgreSQL service found. Install PostgreSQL 16 (https://www.postgresql.org/download/windows/) first.'
    }
    if (@($postgres | Where-Object { $_.Status -eq 'Running' }).Count -eq 0) {
        throw "The PostgreSQL service $($postgres[0].Name) is not running. Start it (Start-Service $($postgres[0].Name)) and run this again."
    }

    Write-Step "Creating folders under $($layout.Root)"
    foreach ($folder in @($layout.Config, $layout.Logs, $layout.Services, $layout.Tools, $layout.CaddyData, $layout.Backups)) {
        New-Item -ItemType Directory -Force -Path $folder | Out-Null
    }
    # A new folder in the root of the disk lets every user of the computer change what is in it. These programs
    # hold the money records and run as services, so: the system and the administrators only. install-services.ps1
    # lets each service in where it needs to be.
    Protect-Folder -Path $layout.Root
    if (-not $layout.App.StartsWith($layout.Root, [StringComparison]::OrdinalIgnoreCase)) {
        Write-Host "Note: the application is in $($layout.App), outside $($layout.Root), so its folder keeps the access it had. Restrict it to the administrators too." -ForegroundColor Yellow
    }

    Push-Location $layout.App
    try {
        Write-Step 'Installing packages (npm ci): this takes a few minutes. After that you are asked for a password.'
        Invoke-Npm -Arguments @('ci')

        Write-Step 'Preparing the database'
        $asked = Request-PostgresPassword
        try {
            $database = @('deploy/setup-database.mjs', '--settings', $layout.Settings)
            # Another installation: a role, a database and a port of its own (kept as they are when its file is there).
            if ($layout.Instance) { $database += @('--instance', $layout.Instance) }
            if ($Port -gt 0) { $database += @('--port', [string]$Port) }
            elseif ($layout.Instance) { $database += @('--port', [string](Get-AppPort -Layout $layout)) }
            Invoke-Native -File 'node' -Arguments $database
        }
        finally {
            if ($asked) { Remove-Item Env:\PGPASSWORD -ErrorAction SilentlyContinue }
        }
    }
    finally {
        Pop-Location
    }

    # The file holds the database password: the system and the administrators only. install-services.ps1
    # adds the account the application runs as.
    Write-Step 'Restricting the settings file'
    Invoke-Native -File 'icacls.exe' -Arguments @(
        $layout.Settings, '/inheritance:r', '/grant:r',
        (Get-Grant $script:SidSystem 'R'),
        (Get-Grant $script:SidAdministrators 'F')
    )

    & "$PSScriptRoot\build.ps1" -Root $Root -NoInstall
    if ($LASTEXITCODE -ne 0) { throw 'The build failed (see above).' }

    Write-Host ''
    Write-Host 'Done. Next: create the users (kassa.ps1 create-user ...), then download-tools.ps1 and install-services.ps1.' -ForegroundColor Green
    if ($layout.Instance) {
        Write-Host "This is the installation '$($layout.Instance)': give every script its folder, -Root `"$($layout.Root)`", and run the scripts of its own copy of the code ($($layout.App))." -ForegroundColor Yellow
    }
}
