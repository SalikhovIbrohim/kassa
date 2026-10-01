#Requires -Version 5.1
<#
.SYNOPSIS
  Updates Kassa to the newest version (or to one you name) and starts it again: one command.

.DESCRIPTION
  Stops the application, fetches the code, installs packages, builds, applies the database
  migrations, starts the application and checks that it answers. The proxy keeps running, so
  anyone who opens the site in those minutes sees an error page, not a dead address.

  Going back to an earlier version is the same command with -Ref and the version to return to. The
  database only moves forward: if a newer version changed it, going back may need the backup.

.PARAMETER Ref
  A commit, a tag or "origin/<branch>" to deploy. Without it the checked-out branch is brought up to
  date (fast-forward only).

.PARAMETER NoServices
  Neither stop nor start services (a machine without them, or a rehearsal of the rest).

.PARAMETER Root
  The folder with config, logs and tools. Default C:\kassa.
#>
[CmdletBinding()]
param(
    [string]$Root = 'C:\kassa',
    [string]$Ref,
    [switch]$NoServices
)

. "$PSScriptRoot\common.ps1"

Invoke-Main {
    $layout = Get-KassaLayout -Root $Root
    Assert-Node
    Assert-Tool -Name git -Hint 'Install Git for Windows from https://git-scm.com, then open a new PowerShell window.'
    if (-not $NoServices) { Assert-Administrator }

    $appService = $null
    if (-not $NoServices) {
        $appService = Get-Service -Name 'KassaApp' -ErrorAction SilentlyContinue
        if (-not $appService) {
            throw 'The service KassaApp is not installed. Run install-services.ps1 first, or use -NoServices.'
        }
    }

    Push-Location $layout.App
    try {
        $dirty = & git status --porcelain --untracked-files=no
        if ($dirty) {
            throw "The checkout in $($layout.App) has local changes. Commit or discard them first (git status shows them)."
        }
        $before = (& git rev-parse HEAD).Trim()
        $beforeText = (& git log -1 --format='%h %s' HEAD).Trim()
        Write-Host "Now running: $beforeText"

        # True once the built files may be half replaced: from then on the old version cannot just be started again.
        $touched = $false
        try {
            if ($appService) {
                Write-Step 'Stopping the application'
                Stop-Service -Name 'KassaApp' -Force
            }

            Write-Step 'Fetching the code'
            Invoke-Native -File 'git' -Arguments @('fetch', '--tags', '--prune', 'origin')
            if ($Ref) {
                Invoke-Native -File 'git' -Arguments @('checkout', '--detach', $Ref)
            }
            else {
                Invoke-Native -File 'git' -Arguments @('pull', '--ff-only')
            }
            Write-Host ('Version: ' + (& git log -1 --format='%h %s' HEAD).Trim())

            $touched = $true
            & "$PSScriptRoot\build.ps1" -Root $Root
            if ($LASTEXITCODE -ne 0) { throw 'The build failed (see above).' }

            if ($appService) {
                Write-Step 'Starting the application'
                Start-Service -Name 'KassaApp'

                Write-Step 'Checking that it answers'
                $answered = $false
                for ($attempt = 1; $attempt -le 20 -and -not $answered; $attempt++) {
                    & node ([IO.Path]::Combine($layout.App, 'deploy', 'check.mjs')) 'http://127.0.0.1:3000' | Out-Null
                    if ($LASTEXITCODE -eq 0) { $answered = $true } else { Start-Sleep -Seconds 3 }
                }
                if (-not $answered) {
                    & node ([IO.Path]::Combine($layout.App, 'deploy', 'check.mjs')) 'http://127.0.0.1:3000'
                    throw "The new version does not answer. Its log: $($layout.Logs)\KassaApp.err.log"
                }
            }
        }
        catch {
            Write-Host ''
            Write-Host "The update failed: $($_.Exception.Message)" -ForegroundColor Red
            Write-Host "To go back to what ran before:  .\deploy\windows\update.ps1 -Ref $before" -ForegroundColor Yellow
            Write-Host '(If the new version changed the database, going back may need the backup.)' -ForegroundColor Yellow
            if ($appService -and -not $touched) {
                # Nothing was replaced yet (no network, say): the old version is still whole.
                Start-Service -Name 'KassaApp' -ErrorAction SilentlyContinue
                Write-Host 'The version that ran before was started again.' -ForegroundColor Yellow
            }
            exit 1
        }
    }
    finally {
        Pop-Location
    }

    Write-Host ''
    Write-Host ('Updated: ' + (& git -C $layout.App log -1 --format='%h %s' HEAD).Trim()) -ForegroundColor Green
}
