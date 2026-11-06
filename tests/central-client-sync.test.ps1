$ErrorActionPreference = 'Stop'
$source = Join-Path $PSScriptRoot '../deploy/windows/sync-claude-mem-central.ps1'
$tokens=$null; $errors=$null
$ast=[Management.Automation.Language.Parser]::ParseFile($source,[ref]$tokens,[ref]$errors)
if ($errors.Count) { throw ($errors.Message -join '; ') }
foreach ($name in @('Get-UpdateAction','Get-CentralVersion','Invoke-Checked')) {
  $definition=$ast.FindAll({param($node) $node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq $name},$true)
  if ($definition.Count -ne 1) { throw "Missing production function $name" }
  Invoke-Expression $definition[0].Extent.Text
}
function Assert-Equal($actual,$expected) { if ($actual -ne $expected) { throw "Expected $expected, got $actual" } }
Assert-Equal (Get-UpdateAction '15.10.0' '15.9.0') 'SyncLocal'
Assert-Equal (Get-UpdateAction '15.10.0' '15.10.0') 'SyncLocal'
Assert-Equal (Get-UpdateAction '15.10.0' '') 'SyncLocal'
Assert-Equal (Get-UpdateAction '15.10.0' '15.11.0') 'UpdateCentral'
Assert-Equal (Get-UpdateAction '15.9.0' '15.10.0') 'UpdateCentral'
foreach ($bad in @('latest','15.10.0;whoami','15.10.0-preview')) {
  $rejected=$false; try { Get-UpdateAction '15.10.0' $bad | Out-Null } catch { $rejected=$true }
  Assert-Equal $rejected $true
}
function Get-WorkerBaseUrl { 'http://fixture.invalid' }
$script:degraded=$false
function Invoke-RestMethod { param($Uri,$Method,$TimeoutSec,$Headers)
  if ($Uri.EndsWith('/api/health')) { return @{status='ok';mcpReady=$true;version='15.10.0';dependencies=@{degraded=$script:degraded}} }
  return @{status='ready'}
}
Assert-Equal (Get-CentralVersion) '15.10.0'
$script:degraded=$true; $rejected=$false
try { Get-CentralVersion | Out-Null } catch { $rejected=$true }
Assert-Equal $rejected $true
function Write-Log { param($Message) }
$pwsh=(Get-Command pwsh).Source
Assert-Equal (Invoke-Checked $pwsh @('-NoProfile','-Command','Write-Output "fixture"')) 'fixture'
$rejected=$false;try { Invoke-Checked $pwsh @('-NoProfile','-Command','exit 7') | Out-Null } catch { $rejected=$true }
Assert-Equal $rejected $true
function Set-RemoteWorkerClientSettings {}
function Set-LocalMarketplaceSource {}
function Ensure-ClaudePlugin { param($Version) }
function Ensure-CodexPlugin { param($Version) }
function Ensure-CliVersion { param($Version) }
function Ensure-MarketplaceVersion { param($Version) $script:followed.Add($Version) }
function Get-CentralVersion { $script:versions.Dequeue() }
$UpdateCentral=$false; $Initialize=$false
$loop=$ast.FindAll({param($node) $node -is [Management.Automation.Language.ForStatementAst] -and $node.Extent.Text -match '\$attempt=1'},$true)
Assert-Equal $loop.Count 1
$script:followed=[Collections.Generic.List[string]]::new()
$script:versions=[Collections.Generic.Queue[string]]::new([string[]]@('15.10.0','15.11.0','15.11.0','15.11.0'))
Invoke-Expression $loop[0].Extent.Text
Assert-Equal ($script:followed -join ',') '15.10.0,15.11.0'
Assert-Equal $target '15.11.0'
$script:versions=[Collections.Generic.Queue[string]]::new([string[]]@('15.10.0','15.11.0','15.11.0','15.12.0','15.12.0','15.13.0'))
$rejected=$false;try { Invoke-Expression $loop[0].Extent.Text } catch { $rejected=$true }
Assert-Equal $rejected $true
$sandbox=Join-Path ([IO.Path]::GetTempPath()) ('central-client-install-'+[guid]::NewGuid().ToString('N'))
$oldConfig=$env:CLAUDE_CONFIG_DIR
try {
  foreach ($clientName in @('IOTFRESH','Log','ThirdComputer')) {
    $env:CLAUDE_CONFIG_DIR=Join-Path $sandbox $clientName
    & $pwsh -NoProfile -File (Join-Path $PSScriptRoot '../deploy/windows/install-central-client.ps1') -InstallOnly | Out-Null
    Assert-Equal $LASTEXITCODE 0
    $guard=Join-Path $env:CLAUDE_CONFIG_DIR 'maintenance/claude-mem-remote-worker-guard.cjs'
    Assert-Equal (Test-Path -LiteralPath $guard) $true
  }
  & $pwsh -NoProfile -File (Join-Path $PSScriptRoot '../deploy/windows/install-central-client.ps1') -InstallOnly | Out-Null
  Assert-Equal $LASTEXITCODE 0
  Assert-Equal (@(Get-ChildItem (Join-Path $env:CLAUDE_CONFIG_DIR 'maintenance/backups') -Recurse -Filter 'sync-claude-mem-central.ps1').Count) 1
} finally {
  $env:CLAUDE_CONFIG_DIR=$oldConfig
  if (Test-Path -LiteralPath $sandbox) {
    $resolved=[IO.Path]::GetFullPath($sandbox)
    if (-not $resolved.StartsWith([IO.Path]::GetFullPath([IO.Path]::GetTempPath()),[StringComparison]::OrdinalIgnoreCase)) { throw 'Unsafe test cleanup path' }
    Remove-Item -LiteralPath $resolved -Recurse -Force
  }
}
Write-Host 'PASS: delayed clients, concurrent targets, invalid versions and degraded central health'
exit 0
