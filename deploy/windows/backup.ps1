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

.PARAMETER Label
  Makes a copy for a purpose, named kassa-<date>-<time>-<label>.dump (update.ps1 asks for "before-update").
  Those are kept apart from the nightly copies (the newest 5 of each label), so that neither pushes out the other.

.PARAMETER Status
  Only look at the copies that are there.

.PARAMETER MaxAgeHours
  With -Status: the age of the newest copy, in hours, above which it is a failure. Default 26.

.OUTPUTS
  The path of the copy that was made (one line), so that update.ps1 can name it.
#>
[CmdletBinding(PositionalBinding = $false)]
param(
    [string]$Root = 'C:\kassa',
    [string]$To,
    [int]$Keep = 0,
    [string]$Label,
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

    $log = [IO.Path]::Combine($layout.Logs, 'backup.log')

    # Where the copies go is decided by backup.mjs (--to, else BACKUP_DIR of the settings file, else the folder
    # under the root), so that the folder that is locked here is the one the copy is made in.
    $whereArguments = @('deploy/backup.mjs', '--settings', $layout.Settings, '--where', '--default-folder', $layout.Backups, '--log', $log)
    if ($To) { $whereArguments += @('--to', $To) }
    Push-Location $layout.App
    $utf8 = Set-Utf8Console
    try {
        $found = @(& node @whereArguments)
        $whereCode = $LASTEXITCODE
    }
    finally {
        Restore-Console $utf8
        Pop-Location
    }
    if ($whereCode -ne 0 -or $found.Count -ne 1) { throw "The folder for the copies could not be found (see the message above; $log has it too)." }
    $folder = [string]$found[0]

    $arguments = @('deploy/backup.mjs', '--settings', $layout.Settings, '--to', $folder)
    # A new folder is for the administrators only: the copies hold every entry and the password hashes. (A folder that
    # is there already keeps the access it has: it may be a disk with other things on it.)
    if (-not $Status -and -not (Test-Path -LiteralPath $folder)) {
        New-Item -ItemType Directory -Force -Path $folder | Out-Null
        try { Protect-Folder -Path $folder | Out-Null }
        catch {
            # A disk that is not NTFS (a USB disk, say) has no access lists to set. The copy is worth more than the lock.
            $warning = "The folder $folder could not be restricted to the administrators ($($_.Exception.Message)); every user of this computer may be able to read the copies."
            Write-Host "Warning: $warning" -ForegroundColor Yellow
            Add-LogLine -Path $log -Text "WARNING $warning"
        }
    }
    if ($Keep -gt 0) { $arguments += @('--keep', "$Keep") }
    if ($Label) { $arguments += @('--label', $Label) }

    if ($Status) {
        $arguments += @('--status', '--max-age-hours', "$MaxAgeHours")
    }
    else {
        $arguments += @('--log', $log)
    }

    Push-Location $layout.App
    $utf8 = Set-Utf8Console
    try {
        # The standard output is kept to read the name of the file from; what goes wrong is on the error output, which shows.
        $output = @(& node @arguments)
        $code = $LASTEXITCODE
    }
    finally {
        Restore-Console $utf8
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
