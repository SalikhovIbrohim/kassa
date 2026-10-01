#Requires -Version 5.1
# Shared by the other scripts in this folder: `. "$PSScriptRoot\common.ps1"`.
# Written for Windows PowerShell 5.1, the one every Windows 10 has: no `&&`, no `??`, no ternary.

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$script:OnWindows = ($env:OS -eq 'Windows_NT')

# A script that exits without running a program first would leave this unset, which strict mode refuses to read.
$global:LASTEXITCODE = 0

# Accounts are named by SID, never by name: "Administrators" is translated on a Windows in another
# language, and icacls then stops with "No mapping between account names and security IDs".
$script:SidSystem = '*S-1-5-18'
$script:SidAdministrators = '*S-1-5-32-544'

# The firewall rules install-services.ps1 makes and uninstall-services.ps1 removes.
$script:FirewallRules = @(
    @{ Name = 'Kassa HTTP (certificate and redirect)'; Port = 80 },
    @{ Name = 'Kassa HTTPS'; Port = 443 }
)

# Where everything lives. $Root is the folder that holds the app, the settings, the logs and the tools.
function Get-KassaLayout {
    param([string]$Root = 'C:\kassa')
    # A full path: the scripts change folders, and a path like .\kassa would then mean something else.
    if (-not [IO.Path]::IsPathRooted($Root)) {
        $Root = [IO.Path]::GetFullPath([IO.Path]::Combine((Get-Location).ProviderPath, $Root))
    }
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
        Backups   = [IO.Path]::Combine($Root, 'backups')
    }
}

function Assert-Administrator {
    # Only so that the scripts can be rehearsed on another system. On Windows this always checks.
    if (-not $script:OnWindows) { return }
    $principal = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
    if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
        throw 'Run this in a PowerShell window opened with "Run as administrator".'
    }
}

# Runs a program and stops the script if it fails: PowerShell does not do that by itself.
# What the program prints goes to the window (Out-Host) and not into the result of the function that called
# this: a function returns everything it prints, so a caller that returns a yes or a no would return a list.
function Invoke-Native {
    param(
        [Parameter(Mandatory)][string]$File,
        [string[]]$Arguments = @()
    )
    & $File @Arguments | Out-Host
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

# node prints UTF-8, and Windows PowerShell 5.1 reads what a program prints with the code page of the console (866
# or 437), so a folder like D:\Copies in Cyrillic would come out garbled in what a script reads back and prints.
# Use around such a call:  $utf8 = Set-Utf8Console  ...  Restore-Console $utf8  (in a finally block). A scheduled
# task has no console to set: then nothing is changed and nothing is restored.
function Set-Utf8Console {
    $previous = $null
    try {
        $previous = [Console]::OutputEncoding
        [Console]::OutputEncoding = New-Object Text.UTF8Encoding($false)
    }
    catch {
        $previous = $null
    }
    $previous
}

function Restore-Console {
    param($Encoding)
    if ($Encoding) {
        try { [Console]::OutputEncoding = $Encoding } catch { }
    }
}

# git, with its answer. A git that fails (a repository of another owner, say) must not turn into an empty string.
function Get-Git {
    param([Parameter(Mandatory)][string[]]$Arguments)
    $output = & git @Arguments
    if ($LASTEXITCODE -ne 0) {
        throw "'git $($Arguments -join ' ')' failed with exit code $LASTEXITCODE (its message is above)."
    }
    ($output | Out-String).Trim()
}

function Assert-Tool {
    param([Parameter(Mandatory)][string]$Name, [Parameter(Mandatory)][string]$Hint)
    if (-not (Get-Command $Name -ErrorAction SilentlyContinue)) {
        throw "'$Name' was not found. $Hint"
    }
}

function Assert-Node {
    Assert-Tool -Name node -Hint 'Install Node.js 22.12 or newer (LTS) from https://nodejs.org, then open a new PowerShell window.'
    $version = (& node --version).TrimStart('v')
    $parts = $version.Split('.')
    # 22.12 and not just 22: the build tool (Vite 8) ships its native part as an optional package that npm leaves out,
    # without an error, on an older Node, and the build then fails with "Cannot find native binding".
    if (([int]$parts[0] -lt 22) -or ([int]$parts[0] -eq 22 -and [int]$parts[1] -lt 12)) {
        throw "Node.js $version is too old: Kassa needs version 22.12 or newer (https://nodejs.org)."
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

# Appends a line, with the time, to a log file (UTF-8 without a byte order mark, which `>>` would not write).
function Add-LogLine {
    param([Parameter(Mandatory)][string]$Path, [Parameter(Mandatory)][string]$Text)
    $folder = [IO.Path]::GetDirectoryName($Path)
    if (-not (Test-Path -LiteralPath $folder)) { New-Item -ItemType Directory -Force -Path $folder | Out-Null }
    $line = '{0:yyyy-MM-dd HH:mm:ss}  {1}{2}' -f (Get-Date), $Text, [Environment]::NewLine
    [IO.File]::AppendAllText($Path, $line, (New-Object Text.UTF8Encoding($false)))
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

# A Windows service, or nothing when there is none (or when this is not Windows, as in a rehearsal of the scripts elsewhere).
function Get-ServiceOrNull {
    param([Parameter(Mandatory)][string]$Name)
    if (-not (Get-Command -Name Get-Service -ErrorAction SilentlyContinue)) { return $null }
    Get-Service -Name $Name -ErrorAction SilentlyContinue
}

# The SID that Windows derives from a service name: the account "NT SERVICE\<name>". The service need not exist.
function Get-ServiceSid {
    param([Parameter(Mandatory)][string]$Name)
    $text = (& sc.exe showsid $Name | Out-String)
    if ($LASTEXITCODE -ne 0) { throw "'sc.exe showsid $Name' failed with exit code $LASTEXITCODE" }
    $match = [regex]::Match($text, 'S-1-5-80(-\d+)+')
    if (-not $match.Success) { throw "The SID of the service $Name could not be read from: $text" }
    '*' + $match.Value
}

# One icacls grant: the account (a SID like '*S-1-5-18') and what it may do ('(OI)(CI)RX').
function Get-Grant {
    param([Parameter(Mandatory)][string]$Sid, [Parameter(Mandatory)][string]$Rights)
    $Sid + ':' + $Rights
}

# Only the system and the administrators may use this folder and what is in it. The scripts that need
# another account to get in add it afterwards.
function Protect-Folder {
    param([Parameter(Mandatory)][string]$Path)
    Invoke-Native -File 'icacls.exe' -Arguments @(
        $Path, '/inheritance:r', '/grant:r',
        (Get-Grant $script:SidSystem '(OI)(CI)F'),
        (Get-Grant $script:SidAdministrators '(OI)(CI)F')
    )
}

# Waits until Windows has really removed a service. While the Services window (services.msc) or the Task
# Manager is open it only marks the service for deletion, and installing it again then fails with a message
# that says little.
function Wait-ServiceRemoved {
    param([Parameter(Mandatory)][string]$Name, [int]$Seconds = 15)
    for ($second = 0; $second -lt $Seconds; $second++) {
        if (-not (Get-Service -Name $Name -ErrorAction SilentlyContinue)) { return }
        Start-Sleep -Seconds 1
    }
    throw "The service $Name is still there (marked for deletion). Close the Services window (services.msc) and the Task Manager and run this again, or restart the computer first."
}

# The port the application listens on: PORT in the settings file, 3000 when it is not there. When the line is
# there twice the last one counts, as it does for the application (node --env-file), and a value in quotes or
# followed by a comment is read too.
function Get-AppPort {
    param([Parameter(Mandatory)]$Layout)
    if (Test-Path -LiteralPath $Layout.Settings) {
        $found = [regex]::Matches([IO.File]::ReadAllText($Layout.Settings), '(?m)^\s*PORT\s*=\s*["'']?(\d+)["'']?\s*(#.*)?$')
        if ($found.Count -gt 0) { return [int]$found[$found.Count - 1].Groups[1].Value }
    }
    3000
}

# Whether the application answers on this machine, trying for up to a minute (it takes a few seconds to start).
# If it never does, the check is run once more with its output shown, which says why.
# The answer is one $true or $false, and nothing else: callers write `if (-not (Wait-Application ...))`, and a
# function returns whatever it prints, so what the check prints goes to the window (Out-Host) and not to the caller.
function Wait-Application {
    param([Parameter(Mandatory)]$Layout)
    $checker = [IO.Path]::Combine($Layout.App, 'deploy', 'check.mjs')
    $address = 'http://127.0.0.1:' + (Get-AppPort -Layout $Layout)
    for ($attempt = 1; $attempt -le 20; $attempt++) {
        & node $checker $address | Out-Null
        if ($LASTEXITCODE -eq 0) { return $true }
        Start-Sleep -Seconds 3
    }
    & node $checker $address | Out-Host
    return $false
}

# Whether a port is among the ports of a firewall rule: they are written as 3000, or as a range, 3000-3010.
function Test-PortListed {
    param($Values, [int]$Port)
    foreach ($value in @($Values)) {
        if ($value -match '^(\d+)$' -and [int]$Matches[1] -eq $Port) { return $true }
        if ($value -match '^(\d+)-(\d+)$' -and [int]$Matches[1] -le $Port -and $Port -le [int]$Matches[2]) { return $true }
    }
    return $false
}

# Which of the ports are being listened on.
function Get-ListeningPort {
    param([Parameter(Mandatory)][int[]]$Port)
    @(Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue |
        Where-Object { $Port -contains $_.LocalPort } |
        ForEach-Object { $_.LocalPort } |
        Sort-Object -Unique)
}

# The password of the PostgreSQL administrator, for the scripts that make a database or put a copy back,
# in PGPASSWORD for the programs that script starts. One that was started with PGPASSWORD set already
# (by another script, or by an automatic test) is not asked. Returns $true when it asked: the caller then
# removes the variable again when it is done, so that it does not stay in the window.
function Request-PostgresPassword {
    if ($env:PGPASSWORD) { return $false }
    $secret = Read-Host -AsSecureString 'Password of the PostgreSQL user "postgres"'
    $bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secret)
    try { $env:PGPASSWORD = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr) }
    finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr) }
    return $true
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
