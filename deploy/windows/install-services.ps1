#Requires -Version 5.1
<#
.SYNOPSIS
  Installs Kassa and its HTTPS proxy (Caddy) as Windows services that start by themselves.

.DESCRIPTION
  Run it after setup.ps1 (and after `kassa.ps1 create-user ...` and download-tools.ps1). It
    - writes the Caddyfile for your address (the one that was there is kept as a .bak),
    - installs the services KassaApp and KassaProxy with WinSW (a small service wrapper, one exe),
    - gives each its own account without rights (NT SERVICE\KassaApp, NT SERVICE\KassaProxy): the
      proxy, which faces the internet, cannot read the database password, and the application cannot
      read the certificate keys. Neither is the all-powerful SYSTEM,
    - opens ports 80 and 443 in the Windows firewall,
    - makes the PostgreSQL service start again by itself if it stops,
    - starts everything and checks that the application answers and that the proxy listens.
  PostgreSQL has its own service already. Safe to run again: the services are replaced.

.PARAMETER Site
  The public address, without https://, e.g. 203-0-113-5.sslip.io (the server's public IP with dashes),
  or a real domain.

.PARAMETER WinSW
  Another WinSW executable than <Root>\tools\WinSW-x64.exe (the one download-tools.ps1 fetches).
  It is copied under the name of each service.

.PARAMETER Caddy
  Another caddy.exe than <Root>\tools\caddy.exe.

.PARAMETER PostgresService
  The name of the PostgreSQL service when it cannot be found by itself (look in services.msc).

.PARAMETER ServiceAccount
  VirtualAccount (default), or LocalSystem as a way out if the services will not start under their own accounts.
#>
[CmdletBinding(PositionalBinding = $false)]
param(
    [Parameter(Mandatory)][string]$Site,
    [string]$WinSW,
    [string]$Root = 'C:\kassa',
    [string]$Caddy,
    [string]$PostgresService,
    [ValidateSet('VirtualAccount', 'LocalSystem')][string]$ServiceAccount = 'VirtualAccount'
)

. "$PSScriptRoot\common.ps1"

Invoke-Main {
    Assert-Administrator
    $layout = Get-KassaLayout -Root $Root
    Assert-Node

    if ($Site -notmatch '^[A-Za-z0-9]([A-Za-z0-9.-]*[A-Za-z0-9])?$') {
        throw "-Site must be a bare address like 203-0-113-5.sslip.io (no https://, no port, no spaces), got '$Site'."
    }

    function Resolve-Tool {
        param([string]$Given, [string]$Default, [string]$Name)
        $path = if ($Given) { $Given } else { $Default }
        if (-not (Test-Path -LiteralPath $path)) {
            throw "$Name was not found at $path. Run download-tools.ps1 first (or pass its path with -$Name)."
        }
        # A relative path would be understood differently by the service, which does not start in this folder.
        (Resolve-Path -LiteralPath $path).Path
    }
    $winswSource = Resolve-Tool -Given $WinSW -Default ([IO.Path]::Combine($layout.Tools, 'WinSW-x64.exe')) -Name 'WinSW'
    $caddyPath = Resolve-Tool -Given $Caddy -Default ([IO.Path]::Combine($layout.Tools, 'caddy.exe')) -Name 'Caddy'

    foreach ($required in @($layout.Settings, [IO.Path]::Combine($layout.App, 'server', 'dist', 'main.js'), [IO.Path]::Combine($layout.App, 'web', 'dist', 'index.html'))) {
        if (-not (Test-Path -LiteralPath $required)) { throw "$required is missing. Run setup.ps1 (or build.ps1) first." }
    }

    # What the application needs to be told, and what a hand-edited file may have lost.
    $settingsText = [IO.File]::ReadAllText($layout.Settings)
    foreach ($line in @('NODE_ENV=production', 'HOST=127.0.0.1', 'TRUST_PROXY=127.0.0.1')) {
        if ($settingsText -notmatch ('(?m)^' + [regex]::Escape($line) + '\s*$')) {
            throw "$($layout.Settings) has no line '$line'. Without it the cookies are not secure or the proxy's address for each client is lost, and every wrong password would lock everybody out. Add the line and run this again."
        }
    }

    $postgres = Resolve-PostgresService -Name $PostgresService
    $node = (Get-Command node).Source
    if ($node.StartsWith([IO.Path]::Combine($env:SystemDrive + '\', 'Users'), [StringComparison]::OrdinalIgnoreCase)) {
        throw "Node.js is installed in a user's folder ($node): a service cannot read it. Install Node.js for all users from https://nodejs.org (it goes to C:\Program Files\nodejs)."
    }

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
            if (Test-Path -LiteralPath $exe) { Invoke-Native -File $exe -Arguments @('uninstall') }
            else { Invoke-Native -File 'sc.exe' -Arguments @('delete', $Id) }
            Wait-ServiceRemoved -Name $Id
        }
        New-Item -ItemType Directory -Force -Path $folder | Out-Null
        Copy-Item -LiteralPath $winswSource -Destination $exe -Force
        Write-Utf8File -Path ([IO.Path]::Combine($folder, "$Id.xml")) -Text $Xml
        Invoke-Native -File $exe -Arguments @('install')
        $account = if ($ServiceAccount -eq 'LocalSystem') { 'LocalSystem' } else { "NT SERVICE\$Id" }
        Invoke-Native -File 'sc.exe' -Arguments @('config', $Id, 'obj=', $account)
    }

    function Grant-Access {
        param([string]$Path, [string]$Sid, [string]$Rights)
        Invoke-Native -File 'icacls.exe' -Arguments @($Path, '/grant', (Get-Grant $Sid $Rights))
    }

    Write-Step 'Writing the Caddyfile'
    New-Item -ItemType Directory -Force -Path $layout.Config, $layout.Logs, $layout.CaddyData | Out-Null
    $caddyfile = ([IO.File]::ReadAllText([IO.Path]::Combine($PSScriptRoot, 'Caddyfile.template'))).Replace('__SITE__', $Site).Replace('__PORT__', [string](Get-AppPort -Layout $layout)).Replace('__LOGS__', $layout.Logs.Replace('\', '/'))
    if ((Test-Path -LiteralPath $layout.Caddyfile) -and ([IO.File]::ReadAllText($layout.Caddyfile) -ne $caddyfile)) {
        $backup = "$($layout.Caddyfile).$(Get-Date -Format 'yyyyMMdd-HHmmss').bak"
        Copy-Item -LiteralPath $layout.Caddyfile -Destination $backup
        Write-Host "The Caddyfile was changed: the one that was there is kept as $backup"
    }
    Write-Utf8File -Path $layout.Caddyfile -Text $caddyfile
    Write-Host "Wrote $($layout.Caddyfile) for https://$Site"

    Write-Step 'Installing the services'
    $appXml = Fill-Template -TemplateName 'KassaApp.xml.template' -Values @{
        NODE = $node; SETTINGS = $layout.Settings; APP = $layout.App; POSTGRES = $postgres; LOGS = $layout.Logs
    }
    $proxyXml = Fill-Template -TemplateName 'KassaProxy.xml.template' -Values @{
        CADDY = $caddyPath; CADDYFILE = $layout.Caddyfile; CADDYDATA = $layout.CaddyData; LOGS = $layout.Logs
    }
    Install-WinSwService -Id 'KassaApp' -Xml $appXml
    Install-WinSwService -Id 'KassaProxy' -Xml $proxyXml

    if ($ServiceAccount -eq 'VirtualAccount') {
        Write-Step 'Letting each service in where it needs to be (a minute, for the packages)'
        $app = Get-ServiceSid -Name 'KassaApp'
        $proxy = Get-ServiceSid -Name 'KassaProxy'
        # The application: its program, its settings (the only account but the administrators that has the password), its log.
        Grant-Access -Path $layout.App -Sid $app -Rights '(OI)(CI)RX'
        Grant-Access -Path $layout.Settings -Sid $app -Rights 'R'
        Grant-Access -Path ([IO.Path]::Combine($layout.Services, 'KassaApp')) -Sid $app -Rights '(OI)(CI)RX'
        # The proxy: its program, its Caddyfile, and the place where it keeps the certificates and their keys.
        Grant-Access -Path $caddyPath -Sid $proxy -Rights 'RX'
        Grant-Access -Path $layout.Caddyfile -Sid $proxy -Rights 'R'
        Grant-Access -Path ([IO.Path]::Combine($layout.Services, 'KassaProxy')) -Sid $proxy -Rights '(OI)(CI)RX'
        Grant-Access -Path $layout.CaddyData -Sid $proxy -Rights '(OI)(CI)M'
        # Both write their logs.
        Grant-Access -Path $layout.Logs -Sid $app -Rights '(OI)(CI)M'
        Grant-Access -Path $layout.Logs -Sid $proxy -Rights '(OI)(CI)M'
    }

    Write-Step 'Opening ports 80 and 443 in the Windows firewall'
    foreach ($rule in $script:FirewallRules) {
        Get-NetFirewallRule -DisplayName $rule.Name -ErrorAction SilentlyContinue | Remove-NetFirewallRule
        New-NetFirewallRule -DisplayName $rule.Name -Direction Inbound -Protocol TCP -LocalPort $rule.Port -Action Allow -Profile Any | Out-Null
    }

    # If PostgreSQL stops (an update of it, a crash), start it again by itself: three tries, a minute apart.
    Invoke-Native -File 'sc.exe' -Arguments @('failure', $postgres, 'reset=', '86400', 'actions=', 'restart/60000/restart/60000/restart/60000')

    Write-Step 'Starting the services'
    Start-Service -Name 'KassaApp'
    Start-Service -Name 'KassaProxy'

    Write-Step 'Checking that the application answers'
    if (-not (Wait-Application -Layout $layout)) {
        throw "The application does not answer (the check above says why). Its log: $($layout.Logs)\KassaApp.err.log (docs/deploy-windows.md, the section on problems)."
    }

    Write-Step 'Checking that the proxy listens on ports 80 and 443'
    $listening = @()
    for ($attempt = 1; $attempt -le 15; $attempt++) {
        $listening = @(Get-ListeningPort -Port @(80, 443))
        if ($listening.Count -eq 2) { break }
        Start-Sleep -Seconds 2
    }
    if ($listening.Count -ne 2) {
        throw "The proxy does not listen on both port 80 and port 443 (listening: $($listening -join ', ')). Another program may use them (IIS, Skype, another web server: `"Get-NetTCPConnection -LocalPort 80 -State Listen`" shows who). The proxy's log: $($layout.Logs)\KassaProxy.err.log"
    }

    Write-Host ''
    Write-Host "Installed. From a phone (not from this server) open https://$Site" -ForegroundColor Green
    Write-Host 'The first start asks Let''s Encrypt for the certificate: it can take a minute. The proxy log says when it is there.'
    Write-Host "Optional, on a laptop with Node.js: node deploy\check.mjs https://$Site"
}
