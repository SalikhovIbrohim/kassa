#Requires -Version 5.1
<#
.SYNOPSIS
  Sets up the nightly copy of the database as a task of the Windows Task Scheduler (or removes it).

.DESCRIPTION
  Makes the task "Kassa backup": every day at the time given (default 03:00) it runs backup.ps1 as the
  system account, with the highest rights it needs and no window. If the computer was off at that time
  the copy is made as soon as it is on. It is stopped after an hour, and tried again (three times, ten
  minutes apart) if it fails. Safe to run again: the task is replaced.

  Where the copies go is the BACKUP_DIR line of the settings file, or <Root>\backups. The system
  account cannot reach a folder on another computer: use a second disk of this one (or a USB disk).
  See docs/deploy-windows.md for how to see that the task works.

.PARAMETER At
  The time of day, 24 hours: 03:00.

.PARAMETER Remove
  Remove the task instead.

.PARAMETER Root
  The folder with config, logs and tools. Default C:\kassa.
#>
[CmdletBinding()]
param(
    [string]$Root = 'C:\kassa',
    [string]$At = '03:00',
    [switch]$Remove
)

. "$PSScriptRoot\common.ps1"

$TaskName = 'Kassa backup'

Invoke-Main {
    Assert-Administrator

    if ($Remove) {
        if (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue) {
            Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
            Write-Host "Removed the task '$TaskName'."
        }
        else {
            Write-Host "There is no task '$TaskName'."
        }
        return
    }

    if ($At -notmatch '^([01]?\d|2[0-3]):[0-5]\d$') { throw "-At must be a time like 03:00, got '$At'." }
    $script = [IO.Path]::Combine($PSScriptRoot, 'backup.ps1')

    $action = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument ('-NoProfile -NonInteractive -ExecutionPolicy Bypass -File "{0}" -Root "{1}"' -f $script, $Root)
    $trigger = New-ScheduledTaskTrigger -Daily -At $At
    # The system account, by its SID: the name of the account is translated on a Windows in another language.
    $system = (New-Object Security.Principal.SecurityIdentifier('S-1-5-18')).Translate([Security.Principal.NTAccount]).Value
    $principal = New-ScheduledTaskPrincipal -UserId $system -LogonType ServiceAccount -RunLevel Highest
    $settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -ExecutionTimeLimit (New-TimeSpan -Hours 1) -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 10) -MultipleInstances IgnoreNew

    Register-ScheduledTask -TaskName $TaskName -Description 'A copy of the Kassa database (deploy\windows\backup.ps1).' -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Force | Out-Null

    Write-Host "The task '$TaskName' is set up: every day at $At." -ForegroundColor Green
    Write-Host 'Try it now:  Start-ScheduledTask -TaskName "Kassa backup"   then   .\deploy\windows\backup.ps1 -Status'
}
