#Requires -Version 5.1
<#
.SYNOPSIS
  Keeps the server awake: no sleep or hibernation while it is plugged in.

.DESCRIPTION
  A sleeping machine does not answer the cashiers. Windows Update may still restart the machine
  for updates: the services start again by themselves (see docs/deploy-windows.md), and the
  active hours in Settings > Update & Security > Windows Update decide when it may do that.
#>
[CmdletBinding()]
param()

. "$PSScriptRoot\common.ps1"

Invoke-Main {
    Assert-Administrator

    Invoke-Native -File 'powercfg.exe' -Arguments @('/change', 'standby-timeout-ac', '0')
    Invoke-Native -File 'powercfg.exe' -Arguments @('/change', 'hibernate-timeout-ac', '0')
    Invoke-Native -File 'powercfg.exe' -Arguments @('/hibernate', 'off')

    Write-Host 'The machine will not sleep or hibernate while plugged in.' -ForegroundColor Green
}
