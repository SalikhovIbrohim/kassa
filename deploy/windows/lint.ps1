#Requires -Version 5.1
<#
.SYNOPSIS
  Checks the scripts in this folder without Windows: they parse, they use nothing newer than the
  Windows PowerShell 5.1 that every Windows 10 has, and the service templates are well-formed XML.

.DESCRIPTION
  The scripts are written for 5.1 but are checked on whatever PowerShell the developer or the CI has
  (usually 7), which accepts more. This is the part of that gap a machine can see: syntax and
  parameters that 5.1 does not know. It exits with 1 if it finds anything.
#>
[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
$problems = 0
function Report([string]$file, [int]$line, [string]$text) {
    Write-Host ("{0}:{1}: {2}" -f $file, $line, $text) -ForegroundColor Red
    $script:problems++
}

# Syntax that only PowerShell 7 has. Matched by name, because older parsers lack some of these types.
$newerSyntax = @('TernaryExpressionAst', 'PipelineChainAst', 'NullConditionalMemberExpressionAst', 'NullConditionalIndexExpressionAst')
# Parameters that only PowerShell 6 and 7 know.
$newerParameters = @('AsHashtable', 'AsArray', 'SkipCertificateCheck', 'SkipHttpErrorCheck', 'AsByteStream', 'Parallel', 'AdditionalChildPath', 'NoNewline')
# Variables that only PowerShell 6 and 7 define.
$newerVariables = @('IsWindows', 'IsLinux', 'IsMacOS', 'PSStyle')

$scripts = @(Get-ChildItem -LiteralPath $PSScriptRoot -Filter '*.ps1')
foreach ($script in $scripts) {
    $name = $script.Name
    $tokens = $null
    $errors = $null
    $ast = [System.Management.Automation.Language.Parser]::ParseFile($script.FullName, [ref]$tokens, [ref]$errors)
    foreach ($e in $errors) { Report $name $e.Extent.StartLineNumber "does not parse: $($e.Message)" }

    # Windows PowerShell 5.1 reads a script without a byte order mark as ANSI: anything but plain ASCII is garbled.
    $text = [IO.File]::ReadAllText($script.FullName)
    $lineNumber = 0
    foreach ($row in ($text -split "`n")) {
        $lineNumber++
        if ($row -match '[^\x00-\x7F]') { Report $name $lineNumber 'contains a character that is not plain ASCII' }
    }

    $first = (Get-Content -LiteralPath $script.FullName -TotalCount 1)
    if ($first -notmatch '^#Requires -Version 5\.1') { Report $name 1 'the first line must be "#Requires -Version 5.1"' }

    $nodes = $ast.FindAll({ $true }, $true)
    foreach ($node in $nodes) {
        $type = $node.GetType().Name
        $line = $node.Extent.StartLineNumber
        if ($type -in $newerSyntax) { Report $name $line "syntax of PowerShell 7 ($type): $($node.Extent.Text)" }
        if ($node -is [System.Management.Automation.Language.MemberExpressionAst] -and $node.PSObject.Properties['NullConditional'] -and $node.NullConditional) {
            Report $name $line "?. is PowerShell 7 only: $($node.Extent.Text)"
        }
        if ($node -is [System.Management.Automation.Language.AssignmentStatementAst] -and $node.Operator.ToString() -eq 'QuestionQuestionEquals') {
            Report $name $line "??= is PowerShell 7 only: $($node.Extent.Text)"
        }
        if ($node -is [System.Management.Automation.Language.BinaryExpressionAst] -and $node.Operator.ToString() -eq 'QuestionQuestion') {
            Report $name $line "?? is PowerShell 7 only: $($node.Extent.Text)"
        }
        if ($node -is [System.Management.Automation.Language.CommandParameterAst] -and $node.ParameterName -in $newerParameters) {
            Report $name $line "parameter -$($node.ParameterName) does not exist in 5.1"
        }
        if ($node -is [System.Management.Automation.Language.VariableExpressionAst] -and $node.VariablePath.UserPath -in $newerVariables) {
            Report $name $line "`$$($node.VariablePath.UserPath) does not exist in 5.1"
        }
    }
}

foreach ($template in (Get-ChildItem -LiteralPath $PSScriptRoot -Filter '*.xml.template')) {
    try { [void][xml](Get-Content -LiteralPath $template.FullName -Raw) }
    catch { Report $template.Name 1 "is not well-formed XML: $($_.Exception.Message)" }
}

if ($problems -gt 0) {
    Write-Host "$problems problem(s)." -ForegroundColor Red
    exit 1
}
Write-Host "OK: $($scripts.Count) scripts and the service templates are fine for Windows PowerShell 5.1."
