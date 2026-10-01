#Requires -Version 5.1
# Shared by the other scripts in this folder: `. "$PSScriptRoot\common.ps1"`.
# Written for Windows PowerShell 5.1, the one every Windows 10 has: no `&&`, no `??`, no ternary.

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$script:OnWindows = ($env:OS -eq 'Windows_NT')

# A script that exits without running a program first would leave this unset, which strict mode refuses to read.
$global:LASTEXITCODE = 0

# Where everything lives. $Root is the folder that holds the app, the settings, the logs and the tools.
function Get-KassaLayout {
    param([string]$Root = 'C:\kassa')
    $app = [IO.Path]::GetFullPath([IO.Path]::Combine($PSScriptRoot, '..', '..'))
    [pscustomobject]@{
        Root      = $Root
        App       = $app                                                  # the repository this script belongs to
        Config    = [IO.Path]::Combine($Root, 'config')
        Settings  = [IO.Path]::Combine($Root, 'config', 'kassa.env')      # holds the database password, not in git
        Caddyfile = [IO.Path]::Combine($Root, 'config', 'Caddyfile')
        Logs      = [IO.Path]::Combine($Root, 'logs')
        Services  = [IO.Path]::Combine($Root, 'services')
        Tools     = [IO.Path]::Combine($Root, 'tools')
        CaddyData = [IO.Path]::Combine($Root, 'caddy')
    }
}

function Assert-Administrator {
    $principal = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
    if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
        throw 'Run this in a PowerShell window opened with "Run as administrator".'
    }
}

# Runs a program and stops the script if it fails: PowerShell does not do that by itself.
function Invoke-Native {
    param(
        [Parameter(Mandatory)][string]$File,
        [string[]]$Arguments = @()
    )
    & $File @Arguments
    if ($LASTEXITCODE -ne 0) {
        throw "'$File $($Arguments -join ' ')' failed with exit code $LASTEXITCODE"
    }
}

# npm is npm.cmd on Windows. Plain `npm` finds npm.ps1 first, which the default execution policy refuses.
function Invoke-Npm {
    param([string[]]$Arguments = @())
    $npm = if ($script:OnWindows) { 'npm.cmd' } else { 'npm' }
    Invoke-Native -File $npm -Arguments $Arguments
}

function Assert-Tool {
    param([Parameter(Mandatory)][string]$Name, [Parameter(Mandatory)][string]$Hint)
    if (-not (Get-Command $Name -ErrorAction SilentlyContinue)) {
        throw "'$Name' was not found. $Hint"
    }
}

function Assert-Node {
    Assert-Tool -Name node -Hint 'Install Node.js 22 (LTS) from https://nodejs.org, then open a new PowerShell window.'
    $version = (& node --version).TrimStart('v')
    if ([int]($version.Split('.')[0]) -lt 22) {
        throw "Node.js $version is too old: Kassa needs version 22 or newer (https://nodejs.org)."
    }
}

function Write-Step {
    param([string]$Text)
    Write-Host ''
    Write-Host "== $Text" -ForegroundColor Cyan
}

# Text files the server reads (settings) must not start with a byte order mark.
function Write-Utf8File {
    param([Parameter(Mandatory)][string]$Path, [Parameter(Mandatory)][string]$Text)
    [IO.File]::WriteAllText($Path, $Text, (New-Object Text.UTF8Encoding($false)))
}

function Resolve-PostgresService {
    param([string]$Name)
    if ($Name) { return $Name }
    $found = @(Get-Service -Name 'postgresql*' -ErrorAction SilentlyContinue)
    if ($found.Count -eq 1) { return $found[0].Name }
    if ($found.Count -eq 0) {
        throw 'No PostgreSQL service found. Install PostgreSQL 16 first, or pass its service name with -PostgresService.'
    }
    throw ('More than one PostgreSQL service found (' + (($found | ForEach-Object { $_.Name }) -join ', ') + '). Say which with -PostgresService.')
}

# Runs the body of a script and turns any error into one plain red line and a nonzero exit code,
# instead of the long block PowerShell prints by default.
function Invoke-Main {
    param([Parameter(Mandatory)][scriptblock]$Body)
    try {
        & $Body
    }
    catch {
        Write-Host ''
        Write-Host "Error: $($_.Exception.Message)" -ForegroundColor Red
        exit 1
    }
}
