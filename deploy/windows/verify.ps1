#Requires -Version 5.1
<#
.SYNOPSIS
  Looks at the whole installation and says what is right and what is not: services, ports, firewall, who
  can read the settings, the application, the certificate, the copies, the clock, the disk.

.DESCRIPTION
  Run it after install-services.ps1, after every restart of the machine you want to be sure about, and
  when something seems wrong. It changes nothing. Every line starts with ok, WARN, FAIL or info; the
  exit code is 1 if there is a FAIL, so the report can be pasted as it is when asking for help.

  It cannot see the one thing that matters most: a phone, away from this machine, opening the address.
  That is the last step of docs/deploy-windows.md.

.PARAMETER Site
  The public address (203-0-113-5.sslip.io): it is checked too, from this machine.

.PARAMETER PostgresService
  The name of the PostgreSQL service when it cannot be found by itself.

.PARAMETER Root
  The folder with config, logs and tools. Default C:\kassa.
#>
[CmdletBinding()]
param(
    [string]$Root = 'C:\kassa',
    [string]$Site,
    [string]$PostgresService
)

. "$PSScriptRoot\common.ps1"

$script:Failures = 0
$script:Warnings = 0

function Write-Report {
    param([ValidateSet('ok', 'WARN', 'FAIL', 'info')][string]$Level, [string]$Name, [string]$Detail)
    $color = switch ($Level) { 'ok' { 'Green' } 'WARN' { 'Yellow' } 'FAIL' { 'Red' } default { 'Gray' } }
    Write-Host ('{0,-5} {1}: {2}' -f $Level, $Name, $Detail) -ForegroundColor $color
    if ($Level -eq 'FAIL') { $script:Failures++ }
    if ($Level -eq 'WARN') { $script:Warnings++ }
}

# One check. If it cannot be made at all, that is a FAIL, and the other checks go on.
function Test-Part {
    param([string]$Name, [scriptblock]$Body)
    try { & $Body }
    catch { Write-Report 'FAIL' $Name ('could not be checked: ' + $_.Exception.Message) }
}

Invoke-Main {
    Assert-Administrator
    $layout = Get-KassaLayout -Root $Root
    $checker = [IO.Path]::Combine($layout.App, 'deploy', 'check.mjs')

    Write-Host "Kassa installation in $($layout.Root), application in $($layout.App)"
    Write-Host ''

    Test-Part 'PostgreSQL service' {
        $name = Resolve-PostgresService -Name $PostgresService
        $service = Get-Service -Name $name
        if ($service.Status -eq 'Running') { Write-Report 'ok' 'PostgreSQL' "$name is running" }
        else { Write-Report 'FAIL' 'PostgreSQL' "$name is $($service.Status)" }
    }

    foreach ($id in @('KassaApp', 'KassaProxy')) {
        Test-Part "service $id" {
            $service = Get-Service -Name $id -ErrorAction SilentlyContinue
            if (-not $service) { Write-Report 'FAIL' $id 'is not installed (install-services.ps1)'; return }
            if ($service.Status -eq 'Running') { Write-Report 'ok' $id 'is running' } else { Write-Report 'FAIL' $id "is $($service.Status) (the log: $($layout.Logs)\$id.err.log)" }
            $registry = Get-ItemProperty -LiteralPath "HKLM:\SYSTEM\CurrentControlSet\Services\$id"
            $startsByItself = ($registry.Start -eq 2)
            $delayed = [bool]($registry.PSObject.Properties['DelayedAutostart'] -and $registry.DelayedAutostart -eq 1)
            if ($startsByItself) { Write-Report 'ok' "$id start" ($(if ($delayed) { 'automatic, delayed: it starts after a restart without anyone signing in' } else { 'automatic' })) }
            else { Write-Report 'FAIL' "$id start" ('it does not start by itself after a restart (an update that stopped half way? sc.exe config ' + $id + ' start= delayed-auto sets it back)') }
            $account = [string]$registry.ObjectName
            if ($account -like 'NT SERVICE\*') { Write-Report 'ok' "$id account" $account }
            elseif ($account -eq 'LocalSystem') { Write-Report 'WARN' "$id account" 'LocalSystem: all-powerful. install-services.ps1 without -ServiceAccount LocalSystem gives it an account of its own.' }
            else { Write-Report 'info' "$id account" $account }
        }
    }

    Test-Part 'ports' {
        $listening = @(Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue)
        foreach ($port in @(80, 443)) {
            if (@($listening | Where-Object { $_.LocalPort -eq $port }).Count -gt 0) { Write-Report 'ok' "port $port" 'the proxy listens' }
            else { Write-Report 'FAIL' "port $port" "nothing listens (another program may hold it: Get-NetTCPConnection -LocalPort $port)" }
        }
        $appPort = Get-AppPort -Layout $layout
        $app = @($listening | Where-Object { $_.LocalPort -eq $appPort })
        if ($app.Count -eq 0) { Write-Report 'FAIL' "port $appPort" 'the application does not listen' }
        elseif (@($app | Where-Object { @('127.0.0.1', '::1') -notcontains $_.LocalAddress }).Count -gt 0) {
            Write-Report 'FAIL' "port $appPort" 'the application listens on more than this machine: HOST=127.0.0.1 is missing from the settings file'
        }
        else { Write-Report 'ok' "port $appPort" 'the application listens on this machine only' }
        $database = @($listening | Where-Object { $_.LocalPort -eq 5432 -and @('127.0.0.1', '::1') -notcontains $_.LocalAddress })
        if ($database.Count -gt 0) { Write-Report 'info' 'port 5432' 'PostgreSQL listens on every network card; pg_hba.conf and the firewall must keep the others out (see the next lines)' }
    }

    Test-Part 'firewall' {
        $appPort = Get-AppPort -Layout $layout
        $rules = @(Get-NetFirewallRule -Direction Inbound -Enabled True -Action Allow -ErrorAction SilentlyContinue)
        $open = @()
        foreach ($rule in $rules) {
            $filter = $rule | Get-NetFirewallPortFilter
            if (@($filter.LocalPort | Where-Object { $_ -eq [string]$appPort -or $_ -eq '5432' }).Count -gt 0) { $open += $rule.DisplayName }
        }
        if ($open.Count -gt 0) { Write-Report 'FAIL' 'firewall' ("inbound rules open port $appPort (the application) or 5432 (the database) to the network: " + ($open -join ', ')) }
        else { Write-Report 'ok' 'firewall' "no rule opens the application ($appPort) or the database (5432) to the network" }
        foreach ($rule in $script:FirewallRules) {
            if (Get-NetFirewallRule -DisplayName $rule.Name -ErrorAction SilentlyContinue) { Write-Report 'ok' "firewall $($rule.Port)" "the rule '$($rule.Name)' is there" }
            else { Write-Report 'FAIL' "firewall $($rule.Port)" "the rule '$($rule.Name)' is missing (install-services.ps1)" }
        }
    }

    Test-Part 'settings file' {
        if (-not (Test-Path -LiteralPath $layout.Settings)) { Write-Report 'FAIL' 'settings' "$($layout.Settings) does not exist"; return }
        $text = [IO.File]::ReadAllText($layout.Settings)
        foreach ($line in @('NODE_ENV=production', 'HOST=127.0.0.1', 'TRUST_PROXY=127.0.0.1')) {
            if ($text -match ('(?m)^' + [regex]::Escape($line) + '\s*$')) { Write-Report 'ok' 'settings' "has $line" }
            else { Write-Report 'FAIL' 'settings' "has no line $line" }
        }
        $everyone = @('S-1-1-0', 'S-1-5-11', 'S-1-5-32-545')
        $let = @()
        foreach ($rule in (Get-Acl -LiteralPath $layout.Settings).Access) {
            $sid = $rule.IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value
            if ($everyone -contains $sid) { $let += $rule.IdentityReference.Value }
        }
        if ($let.Count -gt 0) { Write-Report 'FAIL' 'settings access' ('can be read by ' + ($let -join ', ') + ': it holds the database password (setup.ps1 locks it)') }
        else { Write-Report 'ok' 'settings access' 'not readable by users of this machine' }
    }

    Test-Part 'application' {
        $address = 'http://127.0.0.1:' + (Get-AppPort -Layout $layout)
        & node $checker $address | Out-Null
        if ($LASTEXITCODE -eq 0) { Write-Report 'ok' 'application' 'answers on this machine (health, web app, manifest, login required)' }
        else { Write-Report 'FAIL' 'application' "does not answer as it should: node $checker $address says why" }
    }

    Test-Part 'certificate' {
        $log = [IO.Path]::Combine($layout.Logs, 'KassaProxy.err.log')
        if (-not (Test-Path -LiteralPath $log)) { Write-Report 'info' 'certificate' 'the proxy has not written a log yet'; return }
        $found = @(Select-String -LiteralPath $log -Pattern 'certificate obtained successfully' -SimpleMatch)
        if ($found.Count -gt 0) { Write-Report 'ok' 'certificate' 'the proxy log says a certificate was obtained' }
        else { Write-Report 'WARN' 'certificate' "no certificate obtained yet, or the log has rolled over: read $log" }
    }

    if ($Site) {
        Test-Part 'public address' {
            & node $checker "https://$Site" | Out-Host
            if ($LASTEXITCODE -eq 0) { Write-Report 'ok' 'public address' "https://$Site passes every check from this machine (a phone elsewhere is the real test)" }
            else { Write-Report 'FAIL' 'public address' "https://$Site does not pass (above). From this machine it can also fail because of the router: try a phone on mobile data." }
        }
    }

    Test-Part 'copies of the database' {
        $task = Get-ScheduledTask -TaskName 'Kassa backup' -ErrorAction SilentlyContinue
        if (-not $task) { Write-Report 'FAIL' 'nightly copy' 'there is no task "Kassa backup" (schedule-backup.ps1)' }
        else {
            $info = $task | Get-ScheduledTaskInfo
            if ($task.State -eq 'Disabled') { Write-Report 'FAIL' 'nightly copy' 'the task is disabled' }
            elseif ($info.LastTaskResult -eq 0) { Write-Report 'ok' 'nightly copy' "the task ran at $($info.LastRunTime) and succeeded" }
            elseif ($info.LastTaskResult -eq 267011) { Write-Report 'WARN' 'nightly copy' 'the task has not run yet (Start-ScheduledTask -TaskName "Kassa backup")' }
            else { Write-Report 'FAIL' 'nightly copy' "the last run ended with result $($info.LastTaskResult) (the log: $($layout.Logs)\backup.log)" }
        }
        & "$PSScriptRoot\backup.ps1" -Root $Root -Status | Out-Null
        if ($LASTEXITCODE -eq 0) { Write-Report 'ok' 'newest copy' 'is less than a day old' }
        else { Write-Report 'FAIL' 'newest copy' 'there is none or it is too old: .\deploy\windows\backup.ps1 -Status says which' }
    }

    Test-Part 'clock' {
        $service = Get-Service -Name 'w32time'
        if ($service.Status -eq 'Running') { Write-Report 'ok' 'clock' 'the Windows Time service runs' }
        else { Write-Report 'WARN' 'clock' 'the Windows Time service is not running (power.ps1 turns it on)' }
    }

    Test-Part 'disk' {
        $drive = New-Object IO.DriveInfo($layout.Root.Substring(0, 1))
        $gigabytes = [math]::Round($drive.AvailableFreeSpace / 1GB, 1)
        if ($gigabytes -lt 5) { Write-Report 'WARN' 'disk' "only $gigabytes GB free on $($drive.Name)" }
        else { Write-Report 'ok' 'disk' "$gigabytes GB free on $($drive.Name)" }
    }

    Write-Host ''
    if ($script:Failures -gt 0) {
        Write-Host "$($script:Failures) FAIL, $($script:Warnings) WARN." -ForegroundColor Red
        exit 1
    }
    Write-Host "Nothing failed ($($script:Warnings) WARN)." -ForegroundColor Green
}
