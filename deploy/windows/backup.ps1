#Requires -Version 5.1
<#
.SYNOPSIS
  Makes a copy of the Kassa database (one compressed file), or says whether the nightly copy is working.

.DESCRIPTION
  Runs deploy\backup.mjs with the settings of this machine. The copy goes to the folder in BACKUP_DIR
  of the settings file, or to <Root>\backups if there is none; the newest 14 copies are kept (BACKUP_KEEP
  or -Keep changes that). What happened is written to <Root>\logs\backup.log.

  The exit code is 0 only if a good copy was made, so the Windows Task Scheduler shows a failure
  (schedule-backup.ps1 sets that task up). It needs no database password: the role of the application
  makes the copy.

  With -Status nothing is copied: it says how old the newest copy is and fails if that is more than
  -MaxAgeHours (default 26), which is how to see that the nightly copy has stopped.

.PARAMETER To
  The folder for the copies, instead of BACKUP_DIR or <Root>\backups. A full path.

.PARAMETER Keep
  How many copies to keep (default 14).

.PARAMETER Status
  Only look at the copies that are there.

.PARAMETER MaxAgeHours
  With -Status: the age of the newest copy, in hours, above which it is a failure. Default 26.

.OUTPUTS
  The path of the copy that was made (one line), so that update.ps1 can name it.
#>
[CmdletBinding()]
param(
    [string]$Root = 'C:\kassa',
    [string]$To,
    [int]$Keep = 0,
    [switch]$Status,
    [int]$MaxAgeHours = 26
)

. "$PSScriptRoot\common.ps1"

Invoke-Main {
    Assert-Administrator
    $layout = Get-KassaLayout -Root $Root
    Assert-Node
    if (-not (Test-Path -LiteralPath $layout.Settings)) {
        throw "The settings file $($layout.Settings) does not exist. Run setup.ps1 first."
    }

    $arguments = @('deploy/backup.mjs', '--settings', $layout.Settings)
    $folder = $To
    if (-not $folder) {
        $settingsText = [IO.File]::ReadAllText($layout.Settings)
        if ($settingsText -notmatch '(?m)^\s*BACKUP_DIR\s*=\s*\S') { $folder = $layout.Backups }
    }
    if ($folder) {
        $arguments += @('--to', $folder)
        # A new folder is for the administrators only: the copies hold every entry and the password hashes.
        if (-not $Status -and -not (Test-Path -LiteralPath $folder)) {
            New-Item -ItemType Directory -Force -Path $folder | Out-Null
            Protect-Folder -Path $folder | Out-Null
        }
    }
    if ($Keep -gt 0) { $arguments += @('--keep', "$Keep") }

    $log = [IO.Path]::Combine($layout.Logs, 'backup.log')
    if ($Status) {
        $arguments += @('--status', '--max-age-hours', "$MaxAgeHours")
    }
    else {
        $arguments += @('--log', $log)
    }

    Push-Location $layout.App
    try {
        # The standard output is kept to read the name of the file from; what goes wrong is on the error output, which shows.
        $output = @(& node @arguments)
        $code = $LASTEXITCODE
    }
    finally {
        Pop-Location
    }
    foreach ($line in $output) { Write-Host $line }
    if ($code -ne 0) {
        if ($Status) { throw 'The nightly copy is not working (see above).' }
        throw "The copy was not made (see the message above; $log has it too)."
    }

    if (-not $Status) {
        $made = @($output | Where-Object { $_ -match '^Copy made: (.+) \([^)]*\)$' })
        if ($made.Count -eq 1) { [void]($made[0] -match '^Copy made: (.+) \([^)]*\)$'); $Matches[1] }
    }
}
