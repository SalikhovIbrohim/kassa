#Requires -Version 5.1
<#
.SYNOPSIS
  Stops and removes the services KassaApp and KassaProxy. The data (database, settings, logs) stays.
#>
[CmdletBinding()]
param(
    [string]$Root = 'C:\kassa'
)

. "$PSScriptRoot\common.ps1"

Invoke-Main {
    Assert-Administrator
    $layout = Get-KassaLayout -Root $Root

    foreach ($id in @('KassaProxy', 'KassaApp')) {
        $exe = [IO.Path]::Combine($layout.Services, $id, "$id.exe")
        if (Get-Service -Name $id -ErrorAction SilentlyContinue) {
            Stop-Service -Name $id -Force -ErrorAction SilentlyContinue
            Invoke-Native -File $exe -Arguments @('uninstall')
            Write-Host "Removed the service $id"
        }
        else {
            Write-Host "The service $id is not installed."
        }
    }
}
