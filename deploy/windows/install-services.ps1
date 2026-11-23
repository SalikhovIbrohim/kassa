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

.PARAMETER NoProxy
  For a machine where ports 80 and 443 are already used by another web server or proxy (IIS, another Caddy).
  Installs only the service KassaApp, which listens on this machine only (the PORT of the settings file), and
  does not touch ports 80 and 443 or the firewall. At the end it prints the few lines to add to the
  Caddyfile of the proxy that is there; -Site is then the name that proxy will serve Kassa under.

.PARAMETER ProxyRoot
  With -NoProxy, for another installation on a machine whose first installation runs the proxy (the cash desk of
  another company, see setup.ps1 -Instance): the root of that first installation, C:\kassa. The site of this one
  is written into its folder config\sites, its Caddyfile is checked with the new site in it, and only then its
  proxy is restarted (a few seconds without an answer for every site it serves).

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
    [switch]$NoProxy,
    [string]$ProxyRoot,
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
    if ($ProxyRoot -and -not $NoProxy) {
        throw '-ProxyRoot goes with -NoProxy: it names the installation whose proxy is to serve this one.'
    }
    # The services this script replaces must be this installation's own, not those of another one on the machine.
    Assert-OwnService -Layout $layout -Name $layout.AppService
    if (-not $NoProxy) { Assert-OwnService -Layout $layout -Name $layout.ProxyService }

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
    $caddyPath = if ($NoProxy) { $null } else { Resolve-Tool -Given $Caddy -Default ([IO.Path]::Combine($layout.Tools, 'caddy.exe')) -Name 'Caddy' }

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

    # What an installation with a name needs of the machine it shares, looked at before anything is installed.
    if ($layout.Instance) {
        # Another installation must not be listening on the port of this one: started on a port that belongs to
        # another, this one would answer under the address of the other whenever the other is stopped.
        # (While the service of this installation runs, the port is its own.)
        $ownService = Get-Service -Name $layout.AppService -ErrorAction SilentlyContinue
        if ((-not $ownService) -or ($ownService.Status -eq 'Stopped')) {
            $appPort = Get-AppPort -Layout $layout
            if (@(Get-ListeningPort -Port @($appPort)).Count -gt 0) {
                throw "Port $appPort is in use already (by another installation on this machine?). Give this one a port of its own: the PORT line of $($layout.Settings). Then run this again."
            }
        }
        # Ports 80 and 443 have one owner on a machine. A proxy of its own would never get them from the proxy that is there.
        if (-not $NoProxy) {
            $ownProxy = Get-Service -Name $layout.ProxyService -ErrorAction SilentlyContinue
            if (((-not $ownProxy) -or ($ownProxy.Status -eq 'Stopped')) -and (@(Get-ListeningPort -Port @(80, 443)).Count -gt 0)) {
                throw 'Ports 80 and 443 are in use already (by the proxy of another installation on this machine?). An installation that the proxy of another one serves is installed with: -NoProxy -ProxyRoot <the folder of that installation>'
            }
        }
    }

    # The proxy of another installation is to serve this one (-ProxyRoot): that it can is found out now.
    $front = $null
    $frontCaddy = $null
    $siteName = $layout.Instance
    if (-not $siteName) { $siteName = 'kassa' }
    if ($ProxyRoot) {
        $front = Get-KassaLayout -Root $ProxyRoot -Other
        if (-not (Get-Service -Name $front.ProxyService -ErrorAction SilentlyContinue)) {
            throw "There is no service $($front.ProxyService): the installation in $($front.Root) does not run the proxy (its own install-services.ps1, without -NoProxy, installs it)."
        }
        $frontCaddy = [IO.Path]::Combine($front.Tools, 'caddy.exe')
        foreach ($required in @($front.Caddyfile, $frontCaddy)) {
            if (-not (Test-Path -LiteralPath $required)) { throw "$required is missing: is the proxy installed from $($front.Root)?" }
        }
        if ([IO.File]::ReadAllText($front.Caddyfile) -notmatch '(?m)^[ \t]*import[ \t]+sites/\*\.caddy[ \t]*\r?$') {
            throw "The Caddyfile $($front.Caddyfile) does not read the sites of other installations: it was written by an earlier version of these scripts. Add a line of its own with the words  import sites/*.caddy  after its first block (the one with 'admin off'), and run this again. (Nothing was installed or changed.)"
        }
        # The port of this installation must be nobody else's among those the proxy serves: the proxy would send the
        # address of this one to the cash desk of another. (Whoever is running just now, the files say it.)
        $ownPort = Get-AppPort -Layout $layout
        if ($ownPort -eq (Get-AppPort -Layout $front)) {
            throw "Port $ownPort is the port of the installation in $($front.Root). Give this installation a port of its own: the PORT line of $($layout.Settings). (Nothing was installed or changed.)"
        }
        foreach ($other in @(Get-ChildItem -LiteralPath $front.Sites -Filter '*.caddy' -ErrorAction SilentlyContinue)) {
            if ($other.Name -eq "$siteName.caddy") { continue }
            if ([IO.File]::ReadAllText($other.FullName) -match ('reverse_proxy\s+127\.0\.0\.1:' + $ownPort + '(\D|$)')) {
                throw "Port $ownPort is the port of another installation that the proxy serves (see $($other.FullName)). Give this installation a port of its own: the PORT line of $($layout.Settings). (Nothing was installed or changed.)"
            }
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

    # One site of the proxy: its address, the port of its application, the file of its access log.
    function Get-CaddySite {
        param([string]$Address, [int]$Port, [string]$AccessLog)
        ([IO.File]::ReadAllText([IO.Path]::Combine($PSScriptRoot, 'CaddySite.template'))).Replace('__SITE__', $Address).Replace('__PORT__', [string]$Port).Replace('__ACCESS_LOG__', $AccessLog.Replace('\', '/'))
    }

    # Puts a file of the proxy (a site, the Caddyfile) back as it was before this run: its earlier text, or no file at all.
    function Restore-CaddyFile {
        param([string]$Path, $Before)
        if ($null -ne $Before) { [IO.File]::WriteAllText($Path, [string]$Before, (New-Object Text.UTF8Encoding($false))) }
        elseif (Test-Path -LiteralPath $Path) { Remove-Item -LiteralPath $Path -Force }
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

    if (-not $NoProxy) {
        Write-Step 'Writing the Caddyfile'
        New-Item -ItemType Directory -Force -Path $layout.Config, $layout.Sites, $layout.Logs, $layout.CaddyData | Out-Null
        $ownSite = Get-CaddySite -Address $Site -Port (Get-AppPort -Layout $layout) -AccessLog ([IO.Path]::Combine($layout.Logs, 'caddy-access.log'))
        $caddyfile = ([IO.File]::ReadAllText([IO.Path]::Combine($PSScriptRoot, 'Caddyfile.template'))).Replace('__OWN_SITE__', $ownSite)
        $caddyfileBefore = $null
        if (Test-Path -LiteralPath $layout.Caddyfile) { $caddyfileBefore = [IO.File]::ReadAllText($layout.Caddyfile) }
        if ((Test-Path -LiteralPath $layout.Caddyfile) -and ([IO.File]::ReadAllText($layout.Caddyfile) -ne $caddyfile)) {
            $backup = "$($layout.Caddyfile).$(Get-Date -Format 'yyyyMMdd-HHmmss').bak"
            Copy-Item -LiteralPath $layout.Caddyfile -Destination $backup
            Write-Host "The Caddyfile was changed: the one that was there is kept as $backup"
        }
        Write-Utf8File -Path $layout.Caddyfile -Text $caddyfile
        Write-Host "Wrote $($layout.Caddyfile) for https://$Site"
        # A proxy that serves other installations reads their sites in too (config\sites): a file there that Caddy does
        # not take would keep every site down. Found out now, before the services are touched.
        if (@(Get-ChildItem -LiteralPath $layout.Sites -Filter '*.caddy' -ErrorAction SilentlyContinue).Count -gt 0) {
            try {
                Invoke-Native -File $caddyPath -Arguments @('validate', '--config', $layout.Caddyfile, '--adapter', 'caddyfile')
            }
            catch {
                Restore-CaddyFile -Path $layout.Caddyfile -Before $caddyfileBefore
                throw "Caddy does not take the Caddyfile with the sites of the other installations in it (its message is above): look at the files in $($layout.Sites). The Caddyfile was put back as it was, and no service was touched."
            }
        }
    }

    Write-Step 'Installing the services'
    $appXml = Fill-Template -TemplateName 'KassaApp.xml.template' -Values @{
        ID = $layout.AppService; NAME = ('Kassa application' + $layout.Label)
        NODE = $node; SETTINGS = $layout.Settings; APP = $layout.App; POSTGRES = $postgres; LOGS = $layout.Logs
    }
    Install-WinSwService -Id $layout.AppService -Xml $appXml
    if (-not $NoProxy) {
        $proxyXml = Fill-Template -TemplateName 'KassaProxy.xml.template' -Values @{
            ID = $layout.ProxyService; NAME = ('Kassa proxy (Caddy)' + $layout.Label)
            CADDY = $caddyPath; CADDYFILE = $layout.Caddyfile; CADDYDATA = $layout.CaddyData; LOGS = $layout.Logs
        }
        Install-WinSwService -Id $layout.ProxyService -Xml $proxyXml
    }

    if ($ServiceAccount -eq 'VirtualAccount') {
        Write-Step 'Letting each service in where it needs to be (a minute, for the packages)'
        $app = Get-ServiceSid -Name $layout.AppService
        # The application: its program, its settings (the only account but the administrators that has the password), its log.
        # Node looks at every folder on the way to its program (realpath), the root of the installation included, and
        # that folder is closed to everybody but the administrators: without this it fails with EPERM before it starts.
        # Only this folder itself (no inheritance): nothing inside it is opened by this.
        Grant-Access -Path $layout.Root -Sid $app -Rights 'RX'
        Grant-Access -Path $layout.App -Sid $app -Rights '(OI)(CI)RX'
        Grant-Access -Path $layout.Settings -Sid $app -Rights 'R'
        Grant-Access -Path ([IO.Path]::Combine($layout.Services, $layout.AppService)) -Sid $app -Rights '(OI)(CI)RX'
        Grant-Access -Path $layout.Logs -Sid $app -Rights '(OI)(CI)M'
        if (-not $NoProxy) {
            $proxy = Get-ServiceSid -Name $layout.ProxyService
            # The proxy: its program, its Caddyfile and the sites of other installations that it reads in, and the
            # place where it keeps the certificates and their keys.
            Grant-Access -Path $caddyPath -Sid $proxy -Rights 'RX'
            Grant-Access -Path $layout.Caddyfile -Sid $proxy -Rights 'R'
            Grant-Access -Path $layout.Sites -Sid $proxy -Rights '(OI)(CI)R'
            Grant-Access -Path ([IO.Path]::Combine($layout.Services, $layout.ProxyService)) -Sid $proxy -Rights '(OI)(CI)RX'
            Grant-Access -Path $layout.CaddyData -Sid $proxy -Rights '(OI)(CI)M'
            Grant-Access -Path $layout.Logs -Sid $proxy -Rights '(OI)(CI)M'
        }
    }

    if (-not $NoProxy) {
        Write-Step 'Opening ports 80 and 443 in the Windows firewall'
        foreach ($rule in $script:FirewallRules) {
            Get-NetFirewallRule -DisplayName $rule.Name -ErrorAction SilentlyContinue | Remove-NetFirewallRule
            New-NetFirewallRule -DisplayName $rule.Name -Direction Inbound -Protocol TCP -LocalPort $rule.Port -Action Allow -Profile Any | Out-Null
        }
    }

    # If PostgreSQL stops (an update of it, a crash), start it again by itself: three tries, a minute apart.
    Invoke-Native -File 'sc.exe' -Arguments @('failure', $postgres, 'reset=', '86400', 'actions=', 'restart/60000/restart/60000/restart/60000')

    Write-Step 'Starting the services'
    Start-Service -Name $layout.AppService
    if (-not $NoProxy) { Start-Service -Name $layout.ProxyService }

    Write-Step 'Checking that the application answers'
    if (-not (Wait-Application -Layout $layout)) {
        throw "The application does not answer (the check above says why). Its log: $($layout.Logs)\$($layout.AppService).err.log (docs/deploy-windows.md, the section on problems)."
    }

    if ($NoProxy) {
        $port = Get-AppPort -Layout $layout
        Write-Host ''
        Write-Host "$($layout.AppService) is installed and answers on 127.0.0.1:$port (this machine only). Nothing is public yet." -ForegroundColor Green

        if ($ProxyRoot) {
            # The proxy of the first installation on this machine serves this one too: one more site for it.
            Write-Step "Adding the site to the proxy of the installation in $($front.Root)"
            $siteFile = [IO.Path]::Combine($front.Sites, "$siteName.caddy")
            $siteBefore = $null
            if (Test-Path -LiteralPath $siteFile) { $siteBefore = [IO.File]::ReadAllText($siteFile) }
            New-Item -ItemType Directory -Force -Path $front.Sites | Out-Null
            # The proxy reads the sites under its own account: let in before the file is there.
            Grant-Access -Path $front.Sites -Sid (Get-ServiceSid -Name $front.ProxyService) -Rights '(OI)(CI)R'
            Write-Utf8File -Path $siteFile -Text (Get-CaddySite -Address $Site -Port $port -AccessLog ([IO.Path]::Combine($front.Logs, "caddy-access-$siteName.log")))
            # Checked before the proxy is touched: a Caddyfile that does not load would take the other sites down too.
            try {
                Invoke-Native -File $frontCaddy -Arguments @('validate', '--config', $front.Caddyfile, '--adapter', 'caddyfile')
            }
            catch {
                Restore-CaddyFile -Path $siteFile -Before $siteBefore
                throw "Caddy does not take its Caddyfile with the new site in it (its message is above). The site was taken out again and the proxy was not touched."
            }
            Write-Host "Wrote $siteFile for https://$Site"

            Write-Step "Restarting the proxy ($($front.ProxyService)): a few seconds without an answer for every site"
            $restartFailed = $null
            try { Restart-Service -Name $front.ProxyService }
            catch { $restartFailed = $_.Exception.Message }
            $listening = @()
            if (-not $restartFailed) {
                for ($attempt = 1; $attempt -le 15; $attempt++) {
                    $listening = @(Get-ListeningPort -Port @(80, 443))
                    if ($listening.Count -eq 2) { break }
                    Start-Sleep -Seconds 2
                }
            }
            if ($restartFailed -or $listening.Count -ne 2) {
                $why = 'of ports 80 and 443 it listens on: ' + ($listening -join ', ')
                if ($restartFailed) { $why = $restartFailed }
                # Back to what worked a minute ago: the proxy without the new site.
                Restore-CaddyFile -Path $siteFile -Before $siteBefore
                try { Restart-Service -Name $front.ProxyService } catch { }
                throw "The proxy did not come back with the new site in it ($why). The site was taken out again and the proxy restarted without it: check that the other sites answer. Its log: $($front.Logs)\$($front.ProxyService).err.log"
            }
            Write-Host ''
            Write-Host "The proxy of the installation in $($front.Root) now serves https://$Site as well." -ForegroundColor Green
            Write-Host 'It asks Let''s Encrypt for the certificate of the new address at once: that can take a minute.'
            Write-Host "Then, from a phone (not from this server), open https://$Site"
            return
        }

        Write-Host 'Add this to the Caddyfile of the proxy that faces the internet, check it and reload it (docs/deploy-windows.md, section 3.1):'
        Write-Host ''
        Write-Host "$Site {"
        Write-Host "    reverse_proxy 127.0.0.1:$port"
        Write-Host '}'
        Write-Host ''
        Write-Host "Then, from a phone (not from this server), open https://$Site"
        return
    }

    Write-Step 'Checking that the proxy listens on ports 80 and 443'
    $listening = @()
    for ($attempt = 1; $attempt -le 15; $attempt++) {
        $listening = @(Get-ListeningPort -Port @(80, 443))
        if ($listening.Count -eq 2) { break }
        Start-Sleep -Seconds 2
    }
    if ($listening.Count -ne 2) {
        throw "The proxy does not listen on both port 80 and port 443 (listening: $($listening -join ', ')). Another program may use them (IIS, Skype, another web server: `"Get-NetTCPConnection -LocalPort 80 -State Listen`" shows who). The proxy's log: $($layout.Logs)\$($layout.ProxyService).err.log"
    }

    Write-Host ''
    Write-Host "Installed. From a phone (not from this server) open https://$Site" -ForegroundColor Green
    Write-Host 'The first start asks Let''s Encrypt for the certificate: it can take a minute. The proxy log says when it is there.'
    Write-Host "Optional, on a laptop with Node.js: node deploy\check.mjs https://$Site"
}
