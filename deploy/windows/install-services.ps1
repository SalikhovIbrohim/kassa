#Requires -Version 5.1
<#
.SYNOPSIS
  Installs Kassa and its HTTPS proxy (Caddy) as Windows services that start by themselves.

.DESCRIPTION
  Run it after setup.ps1 (and after `kassa.ps1 create-user ...`). It
    - writes the Caddyfile for your address,
    - installs the services KassaApp and KassaProxy with WinSW (a small service wrapper, one exe),
    - lets them run as NT AUTHORITY\LocalService (not as the all-powerful SYSTEM),
    - opens ports 80 and 443 in the Windows firewall,
    - starts everything and checks that the app answers.
  PostgreSQL has its own service already. Safe to run again: the services are replaced.

.PARAMETER Site
  The public address, without https://, e.g. 203-0-113-5.sslip.io (your server's IP with dashes), or a real domain.

.PARAMETER WinSW
  Path to the WinSW executable you downloaded (https://github.com/winsw/winsw/releases, the 2.x .NET Framework
  build, e.g. WinSW-x64.exe). It is copied under the name of each service. Not needed on a second run.

.PARAMETER Caddy
  Path to caddy.exe. Default <Root>\tools\caddy.exe.

.PARAMETER PostgresService
  The name of the PostgreSQL service when it cannot be found by itself (look in services.msc).

.PARAMETER ServiceAccount
  LocalService (default) or LocalSystem, as a way out if the services will not start under LocalService.
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory)][string]$Site,
    [string]$WinSW,
    [string]$Root = 'C:\kassa',
    [string]$Caddy,
    [string]$PostgresService,
    [ValidateSet('LocalService', 'LocalSystem')][string]$ServiceAccount = 'LocalService'
)

. "$PSScriptRoot\common.ps1"

Invoke-Main {
    Assert-Administrator
    $layout = Get-KassaLayout -Root $Root
    Assert-Node

    if ($Site -match '[/:\s]') { throw "-Site must be a bare address like 203-0-113-5.sslip.io, got '$Site'." }
    if (-not $Caddy) { $Caddy = [IO.Path]::Combine($layout.Tools, 'caddy.exe') }
    $winswCopy = [IO.Path]::Combine($layout.Tools, 'winsw.exe')
    if ($WinSW) {
        if (-not (Test-Path -LiteralPath $WinSW)) { throw "WinSW was not found at $WinSW." }
        New-Item -ItemType Directory -Force -Path $layout.Tools | Out-Null
        Copy-Item -LiteralPath $WinSW -Destination $winswCopy -Force
    }
    if (-not (Test-Path -LiteralPath $winswCopy)) {
        throw "WinSW is needed: download WinSW-x64.exe (version 2.x) from https://github.com/winsw/winsw/releases and pass its path with -WinSW."
    }
    if (-not (Test-Path -LiteralPath $Caddy)) {
        throw "Caddy is needed: download caddy.exe (Windows amd64) from https://caddyserver.com/download and put it at $Caddy, or pass -Caddy."
    }
    foreach ($required in @($layout.Settings, [IO.Path]::Combine($layout.App, 'server', 'dist', 'main.js'), [IO.Path]::Combine($layout.App, 'web', 'dist', 'index.html'))) {
        if (-not (Test-Path -LiteralPath $required)) { throw "$required is missing. Run setup.ps1 (or build.ps1) first." }
    }
    $postgres = Resolve-PostgresService -Name $PostgresService
    $node = (Get-Command node).Source

    function Fill-Template {
        param([string]$TemplateName, [hashtable]$Values)
        $text = [IO.File]::ReadAllText([IO.Path]::Combine($PSScriptRoot, $TemplateName))
        foreach ($key in $Values.Keys) {
            $text = $text.Replace("__${key}__", [Security.SecurityElement]::Escape($Values[$key]))
        }
        $text
    }

    function Install-WinSwService {
        param([string]$Id, [string]$Xml)
        $folder = [IO.Path]::Combine($layout.Services, $Id)
        $exe = [IO.Path]::Combine($folder, "$Id.exe")
        if (Get-Service -Name $Id -ErrorAction SilentlyContinue) {
            Write-Host "Replacing the service $Id"
            Stop-Service -Name $Id -Force -ErrorAction SilentlyContinue
            Invoke-Native -File $exe -Arguments @('uninstall')
        }
        New-Item -ItemType Directory -Force -Path $folder | Out-Null
        Copy-Item -LiteralPath $winswCopy -Destination $exe -Force
        Write-Utf8File -Path ([IO.Path]::Combine($folder, "$Id.xml")) -Text $Xml
        Invoke-Native -File $exe -Arguments @('install')
        if ($ServiceAccount -eq 'LocalService') {
            Invoke-Native -File 'sc.exe' -Arguments @('config', $Id, 'obj=', 'NT AUTHORITY\LocalService')
        }
    }

    Write-Step 'Writing the Caddyfile'
    New-Item -ItemType Directory -Force -Path $layout.Config, $layout.Logs, $layout.CaddyData | Out-Null
    $caddyfile = ([IO.File]::ReadAllText([IO.Path]::Combine($PSScriptRoot, 'Caddyfile.template'))).Replace('__SITE__', $Site).Replace('__LOGS__', $layout.Logs.Replace('\', '/'))
    Write-Utf8File -Path $layout.Caddyfile -Text $caddyfile
    Write-Host "Wrote $($layout.Caddyfile) for https://$Site"

    Write-Step 'Installing the services'
    $appXml = Fill-Template -TemplateName 'KassaApp.xml.template' -Values @{
        NODE = $node; SETTINGS = $layout.Settings; APP = $layout.App; POSTGRES = $postgres; LOGS = $layout.Logs
    }
    $proxyXml = Fill-Template -TemplateName 'KassaProxy.xml.template' -Values @{
        CADDY = $Caddy; CADDYFILE = $layout.Caddyfile; CADDYDATA = $layout.CaddyData; LOGS = $layout.Logs
    }
    Install-WinSwService -Id 'KassaApp' -Xml $appXml
    Install-WinSwService -Id 'KassaProxy' -Xml $proxyXml

    if ($ServiceAccount -eq 'LocalService') {
        Write-Step 'Letting the services read and write what they need'
        $account = 'NT AUTHORITY\LocalService'
        Invoke-Native -File 'icacls.exe' -Arguments @($layout.Settings, '/grant', "${account}:(R)")
        foreach ($folder in @($layout.Logs, $layout.CaddyData)) {
            Invoke-Native -File 'icacls.exe' -Arguments @($folder, '/grant', "${account}:(OI)(CI)M")
        }
        Invoke-Native -File 'icacls.exe' -Arguments @($layout.App, '/grant', "${account}:(OI)(CI)RX")
    }

    Write-Step 'Opening ports 80 and 443 in the Windows firewall'
    foreach ($rule in @(@{ Name = 'Kassa HTTP (certificate and redirect)'; Port = 80 }, @{ Name = 'Kassa HTTPS'; Port = 443 })) {
        Get-NetFirewallRule -DisplayName $rule.Name -ErrorAction SilentlyContinue | Remove-NetFirewallRule
        New-NetFirewallRule -DisplayName $rule.Name -Direction Inbound -Protocol TCP -LocalPort $rule.Port -Action Allow -Profile Any | Out-Null
    }

    Write-Step 'Starting the services'
    Start-Service -Name 'KassaApp'
    Start-Service -Name 'KassaProxy'

    Write-Step 'Checking that the application answers'
    $answered = $false
    for ($attempt = 1; $attempt -le 20 -and -not $answered; $attempt++) {
        & node ([IO.Path]::Combine($layout.App, 'deploy', 'check.mjs')) 'http://127.0.0.1:3000' | Out-Null
        if ($LASTEXITCODE -eq 0) { $answered = $true } else { Start-Sleep -Seconds 3 }
    }
    if (-not $answered) {
        throw "The application does not answer. See $($layout.Logs)\KassaApp.err.log and docs/deploy-windows.md, section on problems."
    }

    Write-Host ''
    Write-Host "Installed. From a phone (not from this server) open https://$Site and run: node deploy\check.mjs https://$Site" -ForegroundColor Green
    Write-Host 'The first start asks Let''s Encrypt for the certificate: it can take a minute.'
}
