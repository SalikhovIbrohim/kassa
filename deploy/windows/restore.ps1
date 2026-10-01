#Requires -Version 5.1
<#
.SYNOPSIS
  Tries a copy of the database (-Check), or puts it in place of the live database (-Replace).

.DESCRIPTION
  One of -Check and -Replace has to be given: the script does not guess, because -Replace changes the live
  database.

  -Check restores the copy into a scratch database, says what is in it, and deletes the scratch
  database again. Nothing that is in use is touched: do this now and then, a copy that was never
  tried is only a hope.

  -Replace stops the application, restores the copy into a new database, and only if that worked
  completely it takes the place of the live one. The database that was live is not deleted: it is renamed
  (kassa_before_restore_<date>), so that the step can be undone, and it can be deleted when the restored
  data has been looked at. If anything fails, the live database stays as it was and the application is
  started again. Entries made after the copy was made are not in it.

  The application is started again at the end, unless -NoStart is given: going back to an earlier
  version of the program takes this step first and update.ps1 -Ref <version> after it, and the
  application must not start in between. With -NoStart the service is also set not to start with the
  machine until update.ps1 has run (it sets that back), so that a restart of the computer in between
  does not start the new version on the old data.

  The password of the PostgreSQL administrator ("postgres") is asked for, because making a database is
  not something the application's own role may do. If PGPASSWORD is set in the window, that is used.

.PARAMETER From
  The copy: a file made by backup.ps1 (kassa-<date>-<time>.dump). A full path, or one relative to this window.

.PARAMETER Check
  Only try the copy, in a scratch database.

.PARAMETER Replace
  Put the copy in place of the live database.

.PARAMETER NoStart
  Do not start the application afterwards.

.PARAMETER Root
  The folder with config, logs and tools. Default C:\kassa.
#>
[CmdletBinding(PositionalBinding = $false)]
param(
    [Parameter(Mandatory)][string]$From,
    [switch]$Check,
    [switch]$Replace,
    [switch]$NoStart,
    [string]$Root = 'C:\kassa'
)

. "$PSScriptRoot\common.ps1"

Invoke-Main {
    if ($Check -and $Replace) { throw 'Give -Check (try the copy) or -Replace (put it in place of the live database), not both.' }
    if (-not $Check -and -not $Replace) {
        throw 'Say what to do with the copy: -Check tries it in a scratch database and changes nothing; -Replace puts it in place of the live database (the one that is live is kept under another name).'
    }
    Assert-Administrator
    $layout = Get-KassaLayout -Root $Root
    Assert-Node
    if (-not (Test-Path -LiteralPath $layout.Settings)) {
        throw "The settings file $($layout.Settings) does not exist. Run setup.ps1 first."
    }
    if (-not (Test-Path -LiteralPath $From)) { throw "There is no file $From." }
    $copy = (Resolve-Path -LiteralPath $From).Path

    $service = Get-ServiceOrNull -Name 'KassaApp'
    $wasRunning = [bool]($service -and $service.Status -ne 'Stopped')
    $mode = if ($Check) { '--check' } else { '--replace' }

    $asked = Request-PostgresPassword
    Push-Location $layout.App
    try {
        if (-not $Check -and $wasRunning) {
            Write-Step 'Stopping the application'
            Stop-Service -Name 'KassaApp' -Force
        }

        $failed = $null
        try {
            Write-Step $(if ($Check) { 'Trying the copy in a scratch database' } else { 'Restoring the copy' })
            Invoke-Native -File 'node' -Arguments @('deploy/restore.mjs', '--settings', $layout.Settings, '--from', $copy, $mode)
        }
        catch {
            $failed = $_.Exception.Message
        }

        # Whatever happened, a database that was live is still live: the application goes on.
        if ($wasRunning -and (-not $Check) -and ($failed -or -not $NoStart)) {
            Write-Step 'Starting the application'
            Start-Service -Name 'KassaApp'
            if (-not (Wait-Application -Layout $layout)) {
                if (-not $failed) { $failed = "The application does not answer after the restore. Its log: $($layout.Logs)\KassaApp.err.log" }
            }
        }
        if ($failed) { throw $failed }

        if ($NoStart -and -not $Check -and $service) {
            # A restart of the computer between this step and update.ps1 must not start the new version on the restored data.
            Invoke-Native -File 'sc.exe' -Arguments @('config', 'KassaApp', 'start=', 'demand')
        }
    }
    finally {
        Pop-Location
        if ($asked) { Remove-Item Env:\PGPASSWORD -ErrorAction SilentlyContinue }
    }

    Write-Host ''
    if ($Check) {
        Write-Host 'The copy can be restored.' -ForegroundColor Green
    }
    elseif ($NoStart) {
        Write-Host 'Restored. The application is not started (-NoStart): go on with update.ps1 -Ref <version>.' -ForegroundColor Green
        if ($service) {
            Write-Host 'Until then the service does not start with the computer. To start it as it is: Start-Service KassaApp, then  sc.exe config KassaApp start= delayed-auto' -ForegroundColor Yellow
        }
    }
    else {
        Write-Host 'Restored.' -ForegroundColor Green
    }
}
