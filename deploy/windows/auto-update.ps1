#Requires -Version 5.1
<#
.SYNOPSIS
  What the nightly task "Kassa update" runs: update.ps1 for the branch it was set up with, its output kept in a log.

.DESCRIPTION
  Run by the Task Scheduler as the system account (see schedule-update.ps1), not by hand: by hand, run update.ps1.
  When there is nothing new, update.ps1 says so and changes nothing, so the application is not even stopped. What
  each night said is appended to <Root>\logs\auto-update.log.

  The code was checked out by an administrator, and git refuses to work in a folder of another owner unless told it
  is safe: this script tells it so for the folder of the application only, for this run only.

.PARAMETER Ref
  The branch to follow.

.PARAMETER Root
  The folder with config, logs and tools. Default C:\kassa.
#>
[CmdletBinding(PositionalBinding = $false)]
param(
    [string]$Root = 'C:\kassa',
    [Parameter(Mandatory)][string]$Ref
)

$app = [IO.Path]::Combine($Root, 'app')
$log = [IO.Path]::Combine($Root, 'logs', 'auto-update.log')

# git takes settings from these variables too: one setting, for this process and what it starts.
$env:GIT_CONFIG_COUNT = '1'
$env:GIT_CONFIG_KEY_0 = 'safe.directory'
$env:GIT_CONFIG_VALUE_0 = $app.Replace('\', '/')

$started = Get-Date -Format 'yyyy-MM-dd HH:mm:ss'
Add-Content -LiteralPath $log -Value "=== $started  update to $Ref"
$output = & powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File ([IO.Path]::Combine($PSScriptRoot, 'update.ps1')) -Root $Root -Ref $Ref 2>&1
$code = $LASTEXITCODE
Add-Content -LiteralPath $log -Value ($output | Out-String)
Add-Content -LiteralPath $log -Value "=== exit code $code"
exit $code
