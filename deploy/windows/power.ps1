#Requires -Version 5.1
<#
.SYNOPSIS
  Keeps the server awake and its clock right: no sleep or hibernation while it is plugged in, and the
  Windows Time service on.

.DESCRIPTION
  A sleeping machine does not answer the cashiers. Closing the lid of a laptop that is used as the
  server does nothing while it is plugged in. The clock matters twice: the certificate is checked by
  date, and the time of every entry is the time of this machine.

  Windows Update may still restart the machine for updates: the services start again by themselves
  (see docs/deploy-windows.md), and the active hours in Settings > Update & Security > Windows Update
  decide when it may do that.
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

    # A computer without a lid may not have this setting: that is no reason to stop.
    & powercfg.exe /setacvalueindex SCHEME_CURRENT SUB_BUTTONS LIDACTION 0
    if ($LASTEXITCODE -eq 0) {
        & powercfg.exe /setactive SCHEME_CURRENT
        Write-Host 'Closing the lid does nothing while plugged in.' -ForegroundColor Green
    }
    else {
        Write-Host 'Note: the lid setting could not be changed (no lid on this computer?).' -ForegroundColor Yellow
    }

    # The Windows Time service keeps the clock right. On a computer that is not in a domain it often starts only on demand,
    # and after a power cut with a flat clock battery the first entries would carry a wrong time.
    Set-Service -Name 'w32time' -StartupType Automatic
    if ((Get-Service -Name 'w32time').Status -ne 'Running') { Start-Service -Name 'w32time' }
    & w32tm.exe /resync
    if ($LASTEXITCODE -eq 0) {
        Write-Host 'The clock is synchronised.' -ForegroundColor Green
    }
    else {
        Write-Host 'Note: the clock could not be synchronised just now (no internet?). The service will try again by itself.' -ForegroundColor Yellow
    }
}
