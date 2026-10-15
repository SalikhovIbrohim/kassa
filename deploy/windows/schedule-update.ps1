#Requires -Version 5.1
<#
.SYNOPSIS
  Sets up the nightly update of Kassa as a task of the Windows Task Scheduler (or removes it).

.DESCRIPTION
  Makes the task "Kassa update": every day at the time given (default 03:30, after the nightly copy of the database
  at 03:00) it runs auto-update.ps1 as the system account, which runs update.ps1 for the branch given. When the
  branch has nothing new, nothing is stopped or changed. A night with something new stops the application for a
  minute or two, copies the database first, and goes back to the version before if the new one does not start.
  What each night said is in <Root>\logs\auto-update.log. Safe to run again: the task is replaced.

.PARAMETER Ref
  The branch to follow, the same one given to update.ps1 -Ref by hand.

.PARAMETER At
  The time of day, 24 hours: 03:30.

.PARAMETER Remove
  Remove the task instead.

.PARAMETER Root
  The folder with config, logs and tools. Default C:\kassa.
#>
[CmdletBinding(PositionalBinding = $false)]
param(
    [string]$Root = 'C:\kassa',
    [string]$Ref,
    [string]$At = '03:30',
    [switch]$Remove
)

. "$PSScriptRoot\common.ps1"

$TaskName = 'Kassa update'

Invoke-Main {
    Assert-Administrator

    if ($Remove) {
        if (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue) {
            Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
            Write-Host "Removed the task '$TaskName'. Updates are by hand again (update.ps1)."
        }
        else {
            Write-Host "There is no task '$TaskName'."
        }
        return
    }

    if (-not $Ref) { throw 'Say which branch to follow: schedule-update.ps1 -Ref <branch>, the same as for update.ps1 -Ref.' }
    if ($Ref -notmatch '^[A-Za-z0-9._/-]+$') { throw "-Ref must be the name of a branch, got '$Ref'." }
    if ($At -notmatch '^([01]?\d|2[0-3]):[0-5]\d$') { throw "-At must be a time like 03:30, got '$At'." }
    $script = [IO.Path]::Combine($PSScriptRoot, 'auto-update.ps1')

    $action = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument ('-NoProfile -NonInteractive -ExecutionPolicy Bypass -File "{0}" -Root "{1}" -Ref "{2}"' -f $script, $Root, $Ref)
    $trigger = New-ScheduledTaskTrigger -Daily -At $At
    # The system account, by its SID: the name of the account is translated on a Windows in another language.
    $system = (New-Object Security.Principal.SecurityIdentifier('S-1-5-18')).Translate([Security.Principal.NTAccount]).Value
    $principal = New-ScheduledTaskPrincipal -UserId $system -LogonType ServiceAccount -RunLevel Highest
    # Not tried again on failure: update.ps1 has gone back to the version before by then, and the next night tries again.
    $settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -ExecutionTimeLimit (New-TimeSpan -Hours 1) -MultipleInstances IgnoreNew -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries

    Register-ScheduledTask -TaskName $TaskName -Description "The nightly update of Kassa to the newest $Ref (deploy\windows\auto-update.ps1)." -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Force | Out-Null

    Write-Host "The task '$TaskName' is set up: every day at $At, to the newest $Ref." -ForegroundColor Green
    Write-Host "Try it now:  Start-ScheduledTask -TaskName ""$TaskName""   then, after a minute or two:  Get-Content $Root\logs\auto-update.log -Tail 30"
}
