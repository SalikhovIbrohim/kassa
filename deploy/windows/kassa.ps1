#Requires -Version 5.1
<#
.SYNOPSIS
  The administration commands (users, opening balances) with the settings of this machine.

.DESCRIPTION
  Run it in a window opened with "Run as administrator": the settings file holds the database password
  and only administrators may read it. Its help text says "npm run admin --"; here that is
  ".\deploy\windows\kassa.ps1".

.EXAMPLE
  .\kassa.ps1 create-user --login ivan --role cashier --name "Ivan Petrov"
  .\kassa.ps1 list-users
  .\kassa.ps1 set-opening-balance --currency RUB --amount 45000.50
  .\kassa.ps1 help
#>
[CmdletBinding()]
param(
    [string]$Root = 'C:\kassa',
    [Parameter(ValueFromRemainingArguments = $true)]
    [string[]]$CommandArguments
)

. "$PSScriptRoot\common.ps1"

Invoke-Main {
    Assert-Administrator
    $layout = Get-KassaLayout -Root $Root
    Assert-Node
    if (-not (Test-Path -LiteralPath $layout.Settings)) {
        throw "The settings file $($layout.Settings) does not exist. Run setup.ps1 first."
    }
    if (-not (Test-Path -LiteralPath ([IO.Path]::Combine($layout.App, 'server', 'dist', 'admin', 'cli.js')))) {
        throw 'The app is not built yet. Run build.ps1 first.'
    }

    Push-Location $layout.App
    try {
        & node "--env-file=$($layout.Settings)" 'server/dist/admin/cli.js' @CommandArguments
        exit $LASTEXITCODE
    }
    finally {
        Pop-Location
    }
}
