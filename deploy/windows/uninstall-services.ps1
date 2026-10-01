#Requires -Version 5.1
<#
.SYNOPSIS
  Stops and removes the services KassaApp and KassaProxy and closes ports 80 and 443 again.
  The data (database, settings, logs, copies) stays.
#>
[CmdletBinding(PositionalBinding = $false)]
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
            # Without the wrapper (its folder was deleted) the service is removed by Windows itself.
            if (Test-Path -LiteralPath $exe) { Invoke-Native -File $exe -Arguments @('uninstall') }
            else { Invoke-Native -File 'sc.exe' -Arguments @('delete', $id) }
            Wait-ServiceRemoved -Name $id
            Write-Host "Removed the service $id"
        }
        else {
            Write-Host "The service $id is not installed."
        }
    }

    foreach ($rule in $script:FirewallRules) {
        $found = @(Get-NetFirewallRule -DisplayName $rule.Name -ErrorAction SilentlyContinue)
        if ($found.Count -gt 0) {
            $found | Remove-NetFirewallRule
            Write-Host "Closed port $($rule.Port) ($($rule.Name))"
        }
    }
}
