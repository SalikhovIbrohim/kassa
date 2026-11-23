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

    Assert-OwnService -Layout $layout -Name $layout.AppService
    Assert-OwnService -Layout $layout -Name $layout.ProxyService

    # Whether this installation runs the proxy (the service is there, or its own Caddyfile says that it did), or is
    # served by the proxy of another one on the machine.
    $hadProxy = [bool](Get-Service -Name $layout.ProxyService -ErrorAction SilentlyContinue) -or (Test-Path -LiteralPath $layout.Caddyfile)
    foreach ($id in @($layout.ProxyService, $layout.AppService)) {
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

    # Ports 80 and 443 are the proxy's. An installation that had no proxy of its own leaves them open: they belong
    # to the installation whose proxy served it.
    if ($hadProxy) {
        foreach ($rule in $script:FirewallRules) {
            $found = @(Get-NetFirewallRule -DisplayName $rule.Name -ErrorAction SilentlyContinue)
            if ($found.Count -gt 0) {
                $found | Remove-NetFirewallRule
                Write-Host "Closed port $($rule.Port) ($($rule.Name))"
            }
        }
    }
    if (-not $hadProxy) {
        $siteName = $layout.Instance
        if (-not $siteName) { $siteName = 'kassa' }
        Write-Host "If the proxy of another installation serves this one, its site is still there: delete the file config\sites\$siteName.caddy in the folder of that installation and restart its proxy." -ForegroundColor Yellow
    }
}
