#Requires -Version 5.1
<#
.SYNOPSIS
  Updates Kassa to the newest version (or to one you name) and starts it again: one command.

.DESCRIPTION
  Fetches the code (the application keeps running meanwhile), then stops the application, makes a copy of
  the database, switches to the new version, installs packages if they changed, builds, applies the
  database migrations, starts the application and checks that it answers. The proxy keeps running, so
  anyone who opens the site in those minutes sees a sentence saying that the cash book is updating, not
  a dead address.

  If something goes wrong before the database was changed, the version that ran before is built and
  started again by itself. If the new version changed the database, the old version cannot run on it
  (it refuses to start, so that it cannot show wrong balances): the copy made just before the update is
  the way back (restore.ps1), and the message says which file it is.

  Without -Ref: the newest version of the branch this checkout follows (of the repository's main branch,
  if a rollback left the checkout on a single version). With -Ref: that version, and this is also how to
  go back to an earlier one.

.PARAMETER Ref
  A commit (a short number like 1a2b3c4), a tag, or a branch name (main) to deploy.

.PARAMETER NoServices
  Neither stop nor start services (a machine without them, or a rehearsal of the rest).

.PARAMETER Root
  The folder with config, logs and tools. Default C:\kassa.
#>
[CmdletBinding(PositionalBinding = $false)]
param(
    [string]$Root = 'C:\kassa',
    [string]$Ref,
    [switch]$NoServices
)

. "$PSScriptRoot\common.ps1"

Invoke-Main {
    Assert-Administrator
    $layout = Get-KassaLayout -Root $Root
    Assert-Node
    Assert-Tool -Name git -Hint 'Install Git for Windows from https://git-scm.com, then open a new PowerShell window.'
    if (-not (Test-Path -LiteralPath $layout.Settings)) {
        throw "The settings file $($layout.Settings) does not exist. Run setup.ps1 first."
    }

    $appService = $null
    if (-not $NoServices) {
        $appService = Get-Service -Name 'KassaApp' -ErrorAction SilentlyContinue
        if (-not $appService) {
            throw 'The service KassaApp is not installed. Run install-services.ps1 first, or use -NoServices.'
        }
    }
    $updateLog = [IO.Path]::Combine($layout.Logs, 'update.log')

    # The steps of build.ps1, here and not by calling it: the switch to another version replaces the scripts in
    # this folder, and a script of an older (or newer) version may not take the same parameters as this one.
    function Build-Application {
        param([bool]$Install)
        Push-Location $layout.App
        try {
            if ($Install) {
                Write-Step 'Installing packages (npm ci)'
                Invoke-Npm -Arguments @('ci')
            }
            Write-Step 'Building the server and the web app'
            Invoke-Npm -Arguments @('run', 'build')
        }
        finally { Pop-Location }
    }

    Push-Location $layout.App
    try {
        if (Get-Git -Arguments @('status', '--porcelain', '--untracked-files=no')) {
            throw "The checkout in $($layout.App) has local changes. Commit or discard them first (git status shows them)."
        }
        $before = Get-Git -Arguments @('rev-parse', 'HEAD')
        $beforeText = Get-Git -Arguments @('log', '-1', '--format=%h %s', 'HEAD')
        $branch = Get-Git -Arguments @('rev-parse', '--abbrev-ref', 'HEAD')    # "HEAD" when no branch is checked out
        Write-Host "Now running: $beforeText"

        # While the application runs, nothing is touched: only the list of versions is fetched.
        Write-Step 'Fetching the code'
        Invoke-Native -File 'git' -Arguments @('fetch', '--tags', '--prune', 'origin')

        $target = $null
        $followBranch = $null
        if ($Ref) {
            # A branch name means the branch on the server, not an old local copy of it.
            & git rev-parse --verify --quiet "origin/$Ref^{commit}" | Out-Null
            $target = if ($LASTEXITCODE -eq 0) { "origin/$Ref" } else { $Ref }
        }
        else {
            $followBranch = $branch
            if ($branch -eq 'HEAD') {
                $symref = Get-Git -Arguments @('ls-remote', '--symref', 'origin', 'HEAD')
                if ($symref -notmatch 'ref:\s+refs/heads/(\S+)\s+HEAD') {
                    throw 'This checkout is on a single version and the main branch of the repository could not be found. Say which version to deploy: update.ps1 -Ref main'
                }
                $followBranch = $Matches[1]
                Write-Host "This checkout is on a single version (after a rollback). Going back to the branch $followBranch."
            }
            $target = "origin/$followBranch"
        }
        & git rev-parse --verify --quiet "$target^{commit}" | Out-Null
        if ($LASTEXITCODE -ne 0) {
            if ($Ref) { throw "'$Ref' is not a branch, a tag or a commit of this repository." }
            throw "The branch $followBranch is not in the repository any more (merged and deleted?). Deploy its successor once, e.g.: .\deploy\windows\update.ps1 -Ref main. After that a plain update.ps1 follows the main branch of the repository."
        }
        $targetSha = Get-Git -Arguments @('rev-parse', "$target^{commit}")

        if ($targetSha -eq $before) {
            if ($followBranch -and $branch -eq 'HEAD') {
                # The files are the ones of the version that runs. The branch is moved onto that same version: an old
                # local copy of the branch must not be what the next update starts from.
                Invoke-Native -File 'git' -Arguments @('checkout', $followBranch)
                Invoke-Native -File 'git' -Arguments @('merge', '--ff-only', $target)
            }
            Write-Host "Nothing to update: $beforeText is the version you asked for." -ForegroundColor Green
            return
        }
        $newText = Get-Git -Arguments @('log', '-1', '--format=%h %s', $targetSha)
        Write-Host "Updating to: $newText"
        $newMigrations = [bool](Get-Git -Arguments @('diff', '--name-only', $before, $targetSha, '--', 'server/migrations'))
        $packagesChange = [bool](Get-Git -Arguments @('diff', '--name-only', $before, $targetSha, '--', 'package.json', 'package-lock.json', 'server/package.json', 'web/package.json'))

        if ($packagesChange) {
            # npm ci deletes the installed packages before it installs: if the registry cannot be reached then, nothing is
            # left to run, and going back needs the registry as well. Better to find out now, while nothing is changed.
            Write-Step 'The packages changed: checking that the npm registry can be reached'
            try { Invoke-Npm -Arguments @('ping') }
            catch { throw 'The npm registry cannot be reached, and this update needs packages from it. Nothing was changed. Check the internet connection and run this again.' }
        }

        # Where the update has got to: what is safe to do about a failure depends on it.
        #   started -> stopped -> copied -> switched -> built -> migrating -> migrated -> answering
        #   (refused, unchanged: the database is not as the new version needs it, or a migration failed with
        #   none applied; either way the database was not changed)
        $stage = 'started'
        $copyPath = $null
        try {
            if ($appService) {
                Write-Step 'Stopping the application'
                Stop-Service -Name 'KassaApp' -Force
                # A restart of the machine in the middle of the update must not start a half built application.
                Invoke-Native -File 'sc.exe' -Arguments @('config', 'KassaApp', 'start=', 'demand')
            }
            $stage = 'stopped'

            Write-Step 'Making a copy of the database'
            # Its own kind of copy: the ones of the nightly task are not pushed out by a day of tries at updating.
            $copyPath = & "$PSScriptRoot\backup.ps1" -Root $Root -Label 'before-update'
            if ($LASTEXITCODE -ne 0 -or -not $copyPath) { throw 'The copy of the database was not made, so nothing was changed.' }
            $stage = 'copied'

            Write-Step 'Switching to the new version'
            if ($Ref) { Invoke-Native -File 'git' -Arguments @('checkout', '--detach', $target) }
            elseif ($branch -eq 'HEAD') {
                Invoke-Native -File 'git' -Arguments @('checkout', $followBranch)
                Invoke-Native -File 'git' -Arguments @('merge', '--ff-only', $target)
            }
            else { Invoke-Native -File 'git' -Arguments @('merge', '--ff-only', $target) }
            $stage = 'switched'
            Write-Host ('Version: ' + (Get-Git -Arguments @('log', '-1', '--format=%h %s', 'HEAD')))

            Build-Application -Install $packagesChange
            $stage = 'built'

            Write-Step 'Applying database migrations'
            $stage = 'migrating'
            Push-Location $layout.App
            try {
                & node "--env-file=$($layout.Settings)" 'server/dist/admin/cli.js' migrate
                $migrateCode = $LASTEXITCODE
            }
            finally { Pop-Location }
            if ($migrateCode -eq 3) {
                # The database is not as this version needs it, and nothing was changed: the version that ran before still can.
                $stage = 'refused'
                throw 'This version will not run on this database (the message above says why).'
            }
            if ($migrateCode -eq 4) {
                # A migration failed and none was applied (each one is all or nothing): the database is as it was.
                $stage = 'unchanged'
                throw 'A migration of the new version failed, and none was applied: the database is as it was (the message above says why).'
            }
            if ($migrateCode -ne 0) { throw "The migrations failed (exit code $migrateCode, see above)." }
            $stage = 'migrated'

            if ($appService) {
                Write-Step 'Starting the application'
                Start-Service -Name 'KassaApp'
                Write-Step 'Checking that it answers'
                if (-not (Wait-Application -Layout $layout)) {
                    throw "The new version does not answer. Its log: $($layout.Logs)\KassaApp.err.log"
                }
            }
            $stage = 'answering'
        }
        catch {
            $reason = $_.Exception.Message
            Write-Host ''
            Write-Host "The update failed: $reason" -ForegroundColor Red
            Add-LogLine -Path $updateLog -Text "FAILED at '$stage' ($beforeText -> $newText): $reason"

            $databaseChanged = $newMigrations -and ($stage -in @('migrating', 'migrated', 'answering'))
            if ($stage -eq 'refused') {
                Write-Host 'If you were going back to an earlier version: the database was changed by a newer one, and an earlier one refuses to run on it. Put back a copy of the database made before that change first:' -ForegroundColor Yellow
                Write-Host '  .\deploy\windows\restore.ps1 -From <a copy made before the update that changed it> -Replace -NoStart' -ForegroundColor Yellow
                Write-Host "  .\deploy\windows\update.ps1 -Ref <that version>" -ForegroundColor Yellow
                Write-Host '(Entries made after that copy are not in it.)' -ForegroundColor Yellow
            }
            if ($databaseChanged) {
                Write-Host 'The new version may have changed the database, and the old version refuses to run on a database that a newer one changed.' -ForegroundColor Yellow
                Write-Host 'Either find out what is wrong with the new version and update again, or go back with the copy made just before the update:' -ForegroundColor Yellow
                Write-Host "  .\deploy\windows\restore.ps1 -From `"$copyPath`" -Replace -NoStart" -ForegroundColor Yellow
                Write-Host "  .\deploy\windows\update.ps1 -Ref $before" -ForegroundColor Yellow
                Write-Host '(Entries made after the copy are not in it.)' -ForegroundColor Yellow
            }
            else {
                try {
                    if ($stage -in @('switched', 'built', 'migrating', 'refused', 'unchanged', 'migrated', 'answering')) {
                        Write-Step "Going back to the version that ran before ($beforeText)"
                        # A new version that was started and crashes is started again by the service itself (that is what
                        # its failure actions are for), while the old one is being built over it.
                        if ($appService) { Stop-Service -Name 'KassaApp' -Force }
                        Invoke-Native -File 'git' -Arguments @('checkout', '--detach', $before)
                        Build-Application -Install $packagesChange
                    }
                    if ($appService) {
                        Start-Service -Name 'KassaApp'
                        if (-not (Wait-Application -Layout $layout)) { throw 'The old version does not answer either.' }
                    }
                    Write-Host "The version that ran before is running again: $beforeText" -ForegroundColor Yellow
                    Add-LogLine -Path $updateLog -Text "Went back to $beforeText"
                }
                catch {
                    Write-Host "Going back did not work: $($_.Exception.Message)" -ForegroundColor Red
                    Write-Host "To try again:  .\deploy\windows\update.ps1 -Ref $before" -ForegroundColor Yellow
                    if ($copyPath) { Write-Host "The copy of the database made before this update: $copyPath" -ForegroundColor Yellow }
                }
            }
            exit 1
        }
        finally {
            # The service starts with the machine again, whatever became of the update.
            if ($appService) {
                & sc.exe config KassaApp start= delayed-auto | Out-Null
            }
        }

        Add-LogLine -Path $updateLog -Text "Updated: $beforeText -> $newText (copy of the database: $copyPath)"
    }
    finally {
        Pop-Location
    }

    Write-Host ''
    Write-Host ('Updated: ' + (Get-Git -Arguments @('-C', $layout.App, 'log', '-1', '--format=%h %s', 'HEAD'))) -ForegroundColor Green
    if ($copyPath) { Write-Host "The copy of the database made before the update: $copyPath" }
}
