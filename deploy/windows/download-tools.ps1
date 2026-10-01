#Requires -Version 5.1
<#
.SYNOPSIS
  Downloads WinSW and Caddy, the two programs that have no installer, into <Root>\tools, and checks that
  they are exactly the files these scripts were tried with.

.DESCRIPTION
  WinSW turns a program into a Windows service; Caddy is the HTTPS front of Kassa. Both are single
  files from their projects' GitHub releases. The versions and the SHA-256 of the files are written
  below: a file with another hash is deleted and the script stops, so a changed or damaged download
  never becomes a service that runs all the time. To use another version, change the version and the
  hash here (the hash of the Caddy file is in the checksum list of its release, in SHA-512).

  Without internet on this machine: download the two files elsewhere, put them in <Root>\tools under
  the names WinSW-x64.exe and caddy.exe, and skip this script.

.PARAMETER Root
  The folder with config, logs and tools. Default C:\kassa.

.PARAMETER Force
  Download again even if the file is there.
#>
[CmdletBinding()]
param(
    [string]$Root = 'C:\kassa',
    [switch]$Force
)

. "$PSScriptRoot\common.ps1"

$WinSwVersion = '2.12.0'
$CaddyVersion = '2.11.4'
$Downloads = @(
    @{
        Name    = 'WinSW'
        File    = 'WinSW-x64.exe'
        Url     = "https://github.com/winsw/winsw/releases/download/v$WinSwVersion/WinSW-x64.exe"
        Sha256  = '05b82d46ad331cc16bdc00de5c6332c1ef818df8ceefcd49c726553209b3a0da'
        InZip   = $null
    },
    @{
        Name    = 'Caddy'
        File    = 'caddy.exe'
        Url     = "https://github.com/caddyserver/caddy/releases/download/v$CaddyVersion/caddy_${CaddyVersion}_windows_amd64.zip"
        Sha256  = '1708333f79e274c7697285afe6d592ab39314e0b131e9ec6bea08ad27df62ebf'
        InZip   = 'caddy.exe'
    }
)

Invoke-Main {
    Assert-Administrator
    $layout = Get-KassaLayout -Root $Root
    New-Item -ItemType Directory -Force -Path $layout.Tools | Out-Null

    # Windows PowerShell 5.1 may offer only old TLS versions to a server that no longer accepts them.
    [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
    # The progress bar makes Invoke-WebRequest many times slower in 5.1.
    $ProgressPreference = 'SilentlyContinue'

    foreach ($item in $Downloads) {
        $target = [IO.Path]::Combine($layout.Tools, $item.File)
        if ((Test-Path -LiteralPath $target) -and -not $Force) {
            Write-Host "$($item.Name): $target is there already (use -Force to download it again)."
            continue
        }

        Write-Step "Downloading $($item.Name)"
        Write-Host $item.Url
        $download = [IO.Path]::Combine([IO.Path]::GetTempPath(), ('kassa-' + [guid]::NewGuid().ToString('N') + '-' + $item.Url.Split('/')[-1]))
        $unpacked = $null
        try {
            try {
                Invoke-WebRequest -UseBasicParsing -Uri $item.Url -OutFile $download
            }
            catch {
                throw "Could not download $($item.Url): $($_.Exception.Message) Download it on another computer, put $($item.File) in $($layout.Tools), and go on with install-services.ps1."
            }

            $actual = (Get-FileHash -LiteralPath $download -Algorithm SHA256).Hash.ToLowerInvariant()
            if ($actual -ne $item.Sha256) {
                throw "The file from $($item.Url) is not the one these scripts expect (SHA-256 $actual, expected $($item.Sha256)). It was deleted."
            }
            Write-Host "SHA-256 is as expected: $actual"

            if ($item.InZip) {
                $unpacked = [IO.Path]::Combine([IO.Path]::GetTempPath(), ('kassa-' + [guid]::NewGuid().ToString('N')))
                Expand-Archive -LiteralPath $download -DestinationPath $unpacked -Force
                Copy-Item -LiteralPath ([IO.Path]::Combine($unpacked, $item.InZip)) -Destination $target -Force
            }
            else {
                Copy-Item -LiteralPath $download -Destination $target -Force
            }
            Write-Host "Saved $target"
        }
        finally {
            Remove-Item -LiteralPath $download -Force -ErrorAction SilentlyContinue
            if ($unpacked) { Remove-Item -LiteralPath $unpacked -Recurse -Force -ErrorAction SilentlyContinue }
        }
    }

    $caddy = [IO.Path]::Combine($layout.Tools, 'caddy.exe')
    if (Test-Path -LiteralPath $caddy) {
        Write-Host ''
        Write-Host ('Caddy says: ' + (& $caddy version))
    }
    Write-Host ''
    Write-Host 'Next: install-services.ps1 -Site <your address>' -ForegroundColor Green
}
