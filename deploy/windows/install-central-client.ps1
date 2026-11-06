param(
  [switch]$UpdateCentral,
  [string]$TargetVersion,
  [switch]$InstallOnly
)
$ErrorActionPreference = 'Stop'
$profileDir = [Environment]::GetFolderPath('UserProfile')
$claudeDir = if ($env:CLAUDE_CONFIG_DIR) { $env:CLAUDE_CONFIG_DIR } else { Join-Path $profileDir '.claude' }
$destination = Join-Path $claudeDir 'maintenance'
$files = @('sync-claude-mem-central.ps1','claude-mem-remote-worker-guard.cjs','claude-mem-ensure-launcher-path.cjs','central-client-compatibility.json')
foreach ($name in $files) {
  if (-not (Test-Path -LiteralPath (Join-Path $PSScriptRoot $name))) { throw "Missing installer file: $name" }
}
New-Item -ItemType Directory -Path $destination -Force | Out-Null
$backup = Join-Path $destination ('backups\' + (Get-Date -Format 'yyyyMMdd-HHmmss-fff'))
foreach ($name in $files) {
  $source = Join-Path $PSScriptRoot $name
  $target = Join-Path $destination $name
  if ([IO.Path]::GetFullPath($source) -eq [IO.Path]::GetFullPath($target)) { continue }
  if (Test-Path -LiteralPath $target) {
    New-Item -ItemType Directory -Path $backup -Force | Out-Null
    Copy-Item -LiteralPath $target -Destination (Join-Path $backup $name)
  }
  Copy-Item -LiteralPath $source -Destination "$target.new" -Force
  Move-Item -LiteralPath "$target.new" -Destination $target -Force
}
Write-Host "Installed central client updater for $env:COMPUTERNAME in $destination"
if ($InstallOnly) { exit 0 }
$sync = Join-Path $destination 'sync-claude-mem-central.ps1'
if ($UpdateCentral) {
  $previous = $env:CLAUDE_MEM_MANUAL_UPDATE
  try {
    $env:CLAUDE_MEM_MANUAL_UPDATE = '1'
    & pwsh -NoLogo -NoProfile -File $sync -Initialize -UpdateCentral -TargetVersion $TargetVersion
    $code = $LASTEXITCODE
  } finally { $env:CLAUDE_MEM_MANUAL_UPDATE = $previous }
} else {
  & pwsh -NoLogo -NoProfile -File $sync -Initialize -SyncLocal
  $code = $LASTEXITCODE
}
exit $code
