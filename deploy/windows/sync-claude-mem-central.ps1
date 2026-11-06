param(
  [switch]$Force,
  [switch]$UpdateCentral,
  [switch]$SyncLocal,
  [switch]$Initialize,
  [string]$TargetVersion
)

# Scheduled invocations must never mutate the central Worker or local clients.
# Only UniGetUI's explicit user-driven Scoop update sets this flag.
if ($env:CLAUDE_MEM_MANUAL_UPDATE -ne '1' -and -not $SyncLocal) {
  Write-Output 'Claude-mem automatic sync disabled. Use UniGetUI manual update.'
  exit 0
}
if ($UpdateCentral -and $SyncLocal) { throw 'Choose UpdateCentral or SyncLocal, not both' }
if ($UpdateCentral -and $TargetVersion -notmatch '^\d+\.\d+\.\d+$') { throw 'UpdateCentral requires an exact stable TargetVersion' }
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

$HomeDir = [Environment]::GetFolderPath('UserProfile')
$ClaudeDir = if ($env:CLAUDE_CONFIG_DIR) { $env:CLAUDE_CONFIG_DIR } else { Join-Path $HomeDir '.claude' }
$MaintenanceDir = Join-Path $ClaudeDir 'maintenance'
$LogPath = Join-Path $MaintenanceDir 'claude-mem-central-sync.log'
$StatusPath = Join-Path $MaintenanceDir 'claude-mem-update-status.json'
$Marketplace = Join-Path $ClaudeDir 'plugins\marketplaces\thedotmack'
$KnownMarketplaces = Join-Path $ClaudeDir 'plugins\known_marketplaces.json'
$InstalledPlugins = Join-Path $ClaudeDir 'plugins\installed_plugins.json'
$SettingsPath = Join-Path $ClaudeDir 'settings.json'
$ClientSettingsPath = Join-Path $HomeDir '.claude-mem\settings.json'
$GuardSource = Join-Path $MaintenanceDir 'claude-mem-remote-worker-guard.cjs'
$PluginId = 'claude-mem@thedotmack'
$CodexPluginId = 'claude-mem@claude-mem-local'
$CodexDir = if ($env:CODEX_HOME) { $env:CODEX_HOME } else { Join-Path $HomeDir '.codex' }
$CodexCacheBase = Join-Path $CodexDir 'plugins\cache\claude-mem-local\claude-mem'
$PinBranch = 'central-worker-pin'
$RemoteWorkerHost = 'claude-mem.414222.xyz'
$RemoteWorkerPort = 80
$CliLauncherPath = $null
$HookLauncherPath = Join-Path $HomeDir 'AppData\Local\claude-mem\bin\claude-mem.exe'
$EnsureLauncherShimPath = Join-Path $MaintenanceDir 'claude-mem-ensure-launcher-path.cjs'

New-Item -ItemType Directory -Path $MaintenanceDir -Force | Out-Null
if ((Test-Path $LogPath) -and (Get-Item $LogPath).Length -gt 1MB) {
  Move-Item -LiteralPath $LogPath -Destination "$LogPath.old" -Force
}

function Write-Log([string]$Message) {
  $line = "[{0}] {1}" -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss zzz'), $Message
  Add-Content -LiteralPath $LogPath -Value $line -Encoding utf8
  Write-Host $line
}

function Invoke-Checked([string]$FilePath, [string[]]$Arguments) {
  $previousErrorPreference = $ErrorActionPreference
  try {
    $ErrorActionPreference = 'Continue'
    $output = [Collections.Generic.List[string]]::new()
    & $FilePath @Arguments 2>&1 | ForEach-Object {
      $output.Add([string]$_)
      Write-Log ("{0}: {1}" -f (Split-Path $FilePath -Leaf), [string]$_)
    }
    $code = $LASTEXITCODE
  } finally {
    $ErrorActionPreference = $previousErrorPreference
  }
  if ($code -ne 0) { throw "$FilePath exited with code $code" }
  return $output.ToArray()
}

function Get-CliLauncherPath {
  if ($script:CliLauncherPath) { return $script:CliLauncherPath }
  $candidate = Get-Command claude-mem.cmd -CommandType Application -ErrorAction SilentlyContinue |
    Select-Object -First 1 -ExpandProperty Source
  $script:CliLauncherPath = if ($candidate) { [string]$candidate } else { 'claude-mem.cmd' }
  return $script:CliLauncherPath
}

function Write-JsonAtomic([string]$Path, $Object) {
  $tmp = "$Path.central-sync.tmp"
  $json = $Object | ConvertTo-Json -Depth 32
  if ((Test-Path -LiteralPath $Path) -and [IO.File]::ReadAllText($Path).Trim() -eq $json.Trim()) { return }
  [IO.File]::WriteAllText($tmp, $json + [Environment]::NewLine, (New-Object Text.UTF8Encoding($false)))
  Move-Item -LiteralPath $tmp -Destination $Path -Force
}

function Pin-ClaudeHookLauncher([string]$HooksPath) {
  if (-not (Test-Path $HooksPath)) { throw "Claude Code hooks configuration missing: $HooksPath" }
  if (-not (Test-Path $HookLauncherPath)) {
    throw "Official claude-mem hook launcher missing: $HookLauncherPath"
  }
  if (-not (Test-Path $EnsureLauncherShimPath)) {
    throw "External ensure-launcher PATH shim missing: $EnsureLauncherShimPath"
  }
  $hooks = Get-Content -LiteralPath $HooksPath -Raw | ConvertFrom-Json
  $changed = $false
  $count = 0
  $pinned = 0
  $shimmed = 0
  foreach ($event in $hooks.hooks.PSObject.Properties) {
    foreach ($group in @($event.Value)) {
      foreach ($hook in @($group.hooks)) {
        if ($hook.type -eq 'command' -and [string]$hook.command -eq 'claude-mem') {
          $hook.command = $HookLauncherPath
          $changed = $true
          $count++
        }
        if ($hook.type -eq 'command' -and [string]$hook.command -eq $HookLauncherPath) {
          $pinned++
        }
        # The upstream ensure-launcher runs its *own* bare-command PATH check.
        # Even when the other hooks are pinned, this check reports a false
        # "shadows the hook launcher" if Scoop is earlier in the parent PATH.
        # Keep the upstream JS unchanged, but put the official launcher first
        # inside this one child process via our external wrapper.
        if ($event.Name -eq 'SessionStart' -and $hook.type -eq 'command' -and [string]$hook.command -eq 'node') {
          $arguments = @($hook.args)
          if ($arguments.Count -eq 1 -and [string]$arguments[0] -match '[/\\]ensure-launcher\.cjs$') {
            $hook.args = @($EnsureLauncherShimPath, [string]$arguments[0])
            $changed = $true
            $shimmed++
          } elseif ($arguments.Count -eq 2 -and [string]$arguments[0] -eq $EnsureLauncherShimPath -and [string]$arguments[1] -match '[/\\]ensure-launcher\.cjs$') {
            $shimmed++
          }
        }
      }
    }
  }
  if ($pinned -eq 0) { throw "No pinned claude-mem hook launcher commands found in $HooksPath" }
  if ($shimmed -ne 1) { throw "Expected one wrapped SessionStart ensure-launcher, found $shimmed in $HooksPath" }
  if ($changed) {
    Write-JsonAtomic -Path $HooksPath -Object $hooks
    Write-Log "Protected $count bare claude-mem hook command(s) and the SessionStart PATH checker in $HooksPath"
  }
}

function Ensure-PluginRuntimeDependencies([string]$PluginRoot) {
  $packagePath = Join-Path $PluginRoot 'package.json'
  if (-not (Test-Path -LiteralPath $packagePath)) { throw "Runtime package.json missing: $packagePath" }
  $package = Get-Content -LiteralPath $packagePath -Raw | ConvertFrom-Json
  $dependencies = @($package.dependencies.PSObject.Properties.Name)
  $missing = @($dependencies | Where-Object {
    $dependencyPath = Join-Path (Join-Path $PluginRoot 'node_modules') ($_.Replace('/', [IO.Path]::DirectorySeparatorChar))
    -not (Test-Path -LiteralPath (Join-Path $dependencyPath 'package.json'))
  })
  $needsInstall = $missing.Count -gt 0
  $zodProbe = @'
const fs = require('node:fs');
const path = require('node:path');
const {createRequire} = require('node:module');
const root = process.argv[1];
const resolve = createRequire(path.join(root, 'package.json'));
const own = fs.realpathSync(path.join(root, 'node_modules', 'zod')).toLowerCase();
for (const spec of ['zod/v3', 'zod/v4', 'zod/v4-mini']) {
  const actual = fs.realpathSync(resolve.resolve(spec)).toLowerCase();
  if (!actual.startsWith(own + path.sep)) throw new Error(spec + ' resolved outside plugin cache');
}
'@
  if (-not $needsInstall) {
    & node -e $zodProbe $PluginRoot 2>$null
    $needsInstall = $LASTEXITCODE -ne 0
  }
  if ($needsInstall) {
    Write-Log "Repairing runtime dependencies ($($missing.Count) missing) in $PluginRoot"
    Push-Location $PluginRoot
    try { Invoke-Checked bun @('install','--production','--omit=optional') | Out-Null }
    finally { Pop-Location }
  }
  $missingAfter = @($dependencies | Where-Object {
    $dependencyPath = Join-Path (Join-Path $PluginRoot 'node_modules') ($_.Replace('/', [IO.Path]::DirectorySeparatorChar))
    -not (Test-Path -LiteralPath (Join-Path $dependencyPath 'package.json'))
  })
  if ($missingAfter.Count -gt 0) {
    throw "Runtime dependencies remain incomplete ($($missingAfter.Count) missing) in $PluginRoot"
  }
  & node -e $zodProbe $PluginRoot
  if ($LASTEXITCODE -ne 0) { throw "zod/v3, zod/v4 or zod/v4-mini verification failed in $PluginRoot" }
  if ($needsInstall) { Write-Log "Runtime dependencies verified ($($dependencies.Count) packages) in $PluginRoot" }
}

function Get-WorkerBaseUrl {
  # The central deployment is authoritative, not an inherited installer PATH
  # or a stale localhost setting. A failed health check must leave caches alone.
  return "http://${RemoteWorkerHost}:$RemoteWorkerPort"
}

function Get-UpdateAction([string]$WorkerVersion, [string]$RequestedVersion) {
  if ($WorkerVersion -notmatch '^\d+\.\d+\.\d+$') { throw 'Invalid central version' }
  if (-not $RequestedVersion) { return 'SyncLocal' }
  if ($RequestedVersion -notmatch '^\d+\.\d+\.\d+$') { throw 'Invalid requested version' }
  if ([version]$WorkerVersion -ge [version]$RequestedVersion) { return 'SyncLocal' }
  return 'UpdateCentral'
}

function Initialize-ClientLayout([string]$Version) {
  foreach ($command in @('git','node','bun','npm.cmd','claude','codex')) {
    if (-not (Get-Command $command -ErrorAction SilentlyContinue)) { throw "Install $command before initializing this computer" }
  }
  $client = if (Test-Path $ClientSettingsPath) { Get-Content $ClientSettingsPath -Raw | ConvertFrom-Json } else { [pscustomobject]@{} }
  if (-not $client.CLAUDE_MEM_WORKER_INGEST_TOKEN -and -not $env:CLAUDE_MEM_WORKER_INGEST_TOKEN) {
    throw 'Configure the central ingest credential on this computer first; no credentials are copied from another computer.'
  }
  if (-not $client.CLAUDE_MEM_WORKER_INGEST_TOKEN) {
    $client | Add-Member NoteProperty CLAUDE_MEM_WORKER_INGEST_TOKEN $env:CLAUDE_MEM_WORKER_INGEST_TOKEN -Force
  }
  New-Item -ItemType Directory -Force -Path (Split-Path $ClientSettingsPath),$ClaudeDir | Out-Null
  Write-JsonAtomic $ClientSettingsPath $client
  if (-not (Test-Path $SettingsPath)) { Write-JsonAtomic $SettingsPath ([pscustomobject]@{}) }
  if (-not (Test-Path $Marketplace)) {
    New-Item -ItemType Directory -Force -Path (Split-Path $Marketplace) | Out-Null
    Invoke-Checked git @('clone','--depth=1','--branch',"v$Version",'https://github.com/thedotmack/claude-mem.git',$Marketplace) | Out-Null
  }
  if (-not (Test-Path (Join-Path $Marketplace '.git'))) { throw "Existing marketplace is not a git checkout: $Marketplace" }
  $known = if (Test-Path $KnownMarketplaces) { Get-Content $KnownMarketplaces -Raw | ConvertFrom-Json } else { $null }
  if (-not $known.thedotmack) { Invoke-Checked claude @('plugin','marketplace','add',$Marketplace) | Out-Null }
  $codexManifest = Join-Path $Marketplace '.agents\plugins\marketplace.json'
  if (-not (Test-Path $codexManifest)) {
    New-Item -ItemType Directory -Force -Path (Split-Path $codexManifest) | Out-Null
    Write-JsonAtomic $codexManifest ([ordered]@{name='claude-mem-local';plugins=@(@{name='claude-mem';source=@{source='local';path='./plugin'};policy=@{installation='AVAILABLE';authentication='ON_INSTALL'}})})
  }
  $markets = (& codex plugin marketplace list --json | Out-String) | ConvertFrom-Json
  if ($LASTEXITCODE -ne 0) { throw 'Unable to read Codex marketplaces' }
  $registered = @($markets.marketplaces | Where-Object name -eq 'claude-mem-local')
  if ($registered.Count -eq 0) { Invoke-Checked codex @('plugin','marketplace','add',$Marketplace) | Out-Null }
  elseif ([IO.Path]::GetFullPath($registered[0].root) -ne [IO.Path]::GetFullPath($Marketplace)) { throw 'claude-mem-local belongs to a different directory; review that registration first' }
  if (-not (Test-Path $HookLauncherPath)) {
    Invoke-Checked node @((Join-Path $Marketplace 'plugin\scripts\ensure-launcher.cjs')) | Out-Null
  }
}

function Invoke-CentralUpdateCheck {
  if ($TargetVersion -notmatch '^\d+\.\d+\.\d+$') { throw 'UniGetUI must supply an exact stable TargetVersion' }
  $ssh = Get-Command ssh.exe -CommandType Application -ErrorAction Stop | Select-Object -First 1 -ExpandProperty Source
  $config = Join-Path $HomeDir '.ssh\config'
  Write-Log "User requested manual central Worker update to $TargetVersion"
  $remote = "/usr/local/sbin/claude-mem-manual-upgrade $TargetVersion"
  Invoke-Checked $ssh @('-F',$config,'-o','BatchMode=yes','-o','ConnectTimeout=10','-o','ServerAliveInterval=15','-o','ServerAliveCountMax=4','us',$remote) | Out-Null
}

function Set-RemoteWorkerClientSettings {
  $updates = [ordered]@{
    CLAUDE_MEM_RUNTIME = 'worker'
    CLAUDE_MEM_WORKER_HOST = $RemoteWorkerHost
    CLAUDE_MEM_WORKER_PORT = [string]$RemoteWorkerPort
    CLAUDE_MEM_WORKER_AUTOSTART = 'false'
    CLAUDE_MEM_HOOK_SPOOL_TRANSPORT = 'http'
  }

  # Do not trust the parent process environment. Already-running terminals and
  # package managers can carry the old localhost settings after a prior install.
  foreach ($key in $updates.Keys) {
    [Environment]::SetEnvironmentVariable($key, [string]$updates[$key], 'Process')
  }

  if (Test-Path $ClientSettingsPath) {
    $client = Get-Content -LiteralPath $ClientSettingsPath -Raw | ConvertFrom-Json
    foreach ($key in $updates.Keys) {
      $client | Add-Member -MemberType NoteProperty -Name $key -Value $updates[$key] -Force
    }
    Write-JsonAtomic -Path $ClientSettingsPath -Object $client
  }

  $claude = Get-Content -LiteralPath $SettingsPath -Raw | ConvertFrom-Json
  if ($null -eq $claude.env -or $claude.env -isnot [psobject]) { $claude.env = [pscustomobject]@{} }
  foreach ($key in $updates.Keys) {
    $claude.env | Add-Member -MemberType NoteProperty -Name $key -Value $updates[$key] -Force
  }
  Write-JsonAtomic -Path $SettingsPath -Object $claude
  Write-Log "Remote Worker client routing pinned to ${RemoteWorkerHost}:$RemoteWorkerPort"
}

function Get-CentralVersion {
  $base = Get-WorkerBaseUrl
  $health = Invoke-RestMethod -Uri "$base/api/health" -Method Get -TimeoutSec 7 -Headers @{ 'User-Agent'='claude-mem-central-sync/1' }
  if ($health.status -ne 'ok' -or $health.mcpReady -ne $true -or $health.dependencies.degraded) { throw 'central Worker is not fully healthy' }
  $version = [string]$health.version
  if ($version -notmatch '^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$') { throw "invalid central Worker version: $version" }
  $ready = Invoke-RestMethod -Uri "$base/api/readiness" -Method Get -TimeoutSec 7 -Headers @{ 'User-Agent'='claude-mem-central-sync/1' }
  if (($ready.status -ne 'ready') -and ($ready.ready -ne $true)) { throw 'central Worker is not ready' }
  return $version
}

function Set-LocalMarketplaceSource {
  $known = Get-Content -LiteralPath $KnownMarketplaces -Raw | ConvertFrom-Json
  $entry = $known.thedotmack
  if ($null -eq $entry) { throw 'thedotmack marketplace entry is missing' }
  $needsWrite = $false
  if ($entry.source.source -ne 'directory' -or [string]$entry.source.path -ne $Marketplace) {
    $entry.source = [pscustomobject]@{ source = 'directory'; path = $Marketplace }
    $needsWrite = $true
  }
  if ($entry.PSObject.Properties['autoUpdate']) {
    $entry.PSObject.Properties.Remove('autoUpdate')
    $needsWrite = $true
  }
  if ($needsWrite) {
    Write-JsonAtomic -Path $KnownMarketplaces -Object $known
    Write-Log 'Claude marketplace switched to local controlled source; independent auto-update disabled'
  }
}

function Apply-RemoteGuard([string]$PluginRoot) {
  $scripts = Join-Path $PluginRoot 'scripts'
  Copy-Item -LiteralPath (Join-Path $MaintenanceDir 'central-client-compatibility.json') -Destination $scripts -Force
  $entry = Join-Path $scripts 'worker-service.cjs'
  $upstream = Join-Path $scripts 'worker-service.central-upstream.cjs'
  if (-not (Test-Path $entry)) {
    if (-not (Test-Path $upstream)) { throw "worker-service.cjs and preserved upstream are missing under $PluginRoot" }
    Copy-Item -LiteralPath $GuardSource -Destination $entry -Force
    & node --check $entry *> $null
    if ($LASTEXITCODE -ne 0) { throw "remote guard syntax check failed under $PluginRoot" }
    Write-Log "Restored missing remote-worker guard under $PluginRoot"
    return
  }
  $head = [IO.File]::ReadAllText($entry)
  if ($head.Contains('CENTRAL_REMOTE_WORKER_GUARD_')) {
    if (-not (Test-Path $upstream)) { throw "guarded entry has no preserved upstream bundle under $PluginRoot" }
    Copy-Item -LiteralPath $GuardSource -Destination $entry -Force
    & node --check $entry *> $null
    if ($LASTEXITCODE -ne 0) { throw "remote guard syntax check failed under $PluginRoot" }
    return
  }
  if (Test-Path $upstream) { Remove-Item -LiteralPath $upstream -Force }
  Move-Item -LiteralPath $entry -Destination $upstream -Force
  Copy-Item -LiteralPath $GuardSource -Destination $entry -Force
  & node --check $entry *> $null
  if ($LASTEXITCODE -ne 0) { throw "remote guard syntax check failed under $PluginRoot" }
  Write-Log "Applied remote-worker mismatch guard to $PluginRoot"
}

function Ensure-MarketplaceVersion([string]$Version) {
  if (-not (Test-Path (Join-Path $Marketplace '.git'))) { throw "marketplace is not a git checkout: $Marketplace" }
  $packagePath = Join-Path $Marketplace 'plugin\package.json'
  $currentVersion = if (Test-Path $packagePath) { [string](Get-Content -LiteralPath $packagePath -Raw | ConvertFrom-Json).version } else { '' }
  $branch = (& git -C $Marketplace rev-parse --abbrev-ref HEAD 2>$null).Trim()
  if ($LASTEXITCODE -ne 0) { throw 'unable to read marketplace git branch' }
  if ($Force -or $currentVersion -ne $Version -or $branch -ne $PinBranch) {
    Write-Log "Pinning marketplace to release v$Version (current=$currentVersion branch=$branch)"
    Invoke-Checked git @('-C',$Marketplace,'fetch','--force','--depth=1','origin',"refs/tags/v${Version}:refs/tags/v${Version}") | Out-Null
    $commit = (& git -C $Marketplace rev-parse "v${Version}^{commit}").Trim()
    if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace($commit)) { throw "cannot resolve v$Version tag commit" }
    Invoke-Checked git @('-C',$Marketplace,'checkout','-B',$PinBranch,$commit,'--force') | Out-Null
    $p = Get-Content -LiteralPath $packagePath -Raw | ConvertFrom-Json
    $m = Get-Content -LiteralPath (Join-Path $Marketplace '.claude-plugin\marketplace.json') -Raw | ConvertFrom-Json
    $declared = [string](($m.plugins | Where-Object { $_.name -eq 'claude-mem' } | Select-Object -First 1).version)
    if ([string]$p.version -ne $Version -or $declared -ne $Version) {
      throw "release tag v$Version does not declare matching plugin version (package=$($p.version), marketplace=$declared)"
    }
    Write-Log "Marketplace pinned to $commit for v$Version"
  }
  Apply-RemoteGuard (Join-Path $Marketplace 'plugin')
  Pin-ClaudeHookLauncher (Join-Path $Marketplace 'plugin\hooks\hooks.json')
  Ensure-PluginRuntimeDependencies (Join-Path $Marketplace 'plugin')
}

function Get-ClaudeInstalledRecord {
  if (-not (Test-Path $InstalledPlugins)) { return $null }
  $installed = Get-Content -LiteralPath $InstalledPlugins -Raw | ConvertFrom-Json
  $records = $installed.plugins.$PluginId
  if ($null -eq $records) { return $null }
  return @($records | Where-Object { $_.scope -eq 'user' })[0]
}

function Ensure-ClaudePlugin([string]$Version) {
  $record = Get-ClaudeInstalledRecord
  $installedVersion = if ($null -ne $record) { [string]$record.version } else { '' }
  if ($installedVersion -ne $Version) {
    Write-Log "Syncing Claude plugin from $installedVersion to $Version"
    if ($null -ne $record) {
      try { Invoke-Checked claude @('plugin','update',$PluginId,'-s','user','-y') | Out-Null } catch { Write-Log "Claude plugin update did not converge: $($_.Exception.Message)" }
    }
    $record = Get-ClaudeInstalledRecord
    $installedVersion = if ($null -ne $record) { [string]$record.version } else { '' }
    if ($installedVersion -ne $Version) {
      if ($null -ne $record) {
        Invoke-Checked claude @('plugin','uninstall',$PluginId,'-s','user') | Out-Null
      }
      Invoke-Checked claude @('plugin','install',$PluginId,'-s','user','-y') | Out-Null
    }
    $record = Get-ClaudeInstalledRecord
    if ($null -eq $record -or [string]$record.version -ne $Version) {
      throw "Claude plugin failed to converge to $Version"
    }
    Write-Log "Claude plugin is now $Version"
  }
  if ($null -eq $record) { $record = Get-ClaudeInstalledRecord }
  Apply-RemoteGuard ([string]$record.installPath)
  Pin-ClaudeHookLauncher (Join-Path ([string]$record.installPath) 'hooks\hooks.json')
  Ensure-PluginRuntimeDependencies ([string]$record.installPath)
}

function Get-CodexPluginRecord {
  $raw = (& codex plugin list --json 2>$null | Out-String)
  $code = $LASTEXITCODE
  if ($code -ne 0) { throw "codex plugin list --json exited with code $code" }
  try {
    $state = $raw | ConvertFrom-Json
  } catch {
    throw "unable to parse codex plugin list JSON: $($_.Exception.Message)"
  }
  return @($state.installed | Where-Object { $_.pluginId -eq $CodexPluginId })[0]
}

function Ensure-CodexPlugin([string]$Version) {
  $record = Get-CodexPluginRecord
  $installedVersion = if ($null -ne $record) { [string]$record.version } else { '' }
  if ($installedVersion -ne $Version) {
    Write-Log "Refreshing Codex plugin registry from $installedVersion to $Version"
    if ($null -ne $record) {
      Invoke-Checked codex @('plugin','remove',$CodexPluginId) | Out-Null
    }
    Invoke-Checked codex @('plugin','add',$CodexPluginId) | Out-Null
    $record = Get-CodexPluginRecord
    if ($null -eq $record -or [string]$record.version -ne $Version) {
      $after = if ($null -ne $record) { [string]$record.version } else { '<missing>' }
      throw "Codex plugin failed to converge to $Version (reported $after)"
    }
    Write-Log "Codex plugin registry is now $Version"
  }

  $cacheRoot = Join-Path $CodexCacheBase $Version
  if (-not (Test-Path (Join-Path $cacheRoot 'scripts\worker-service.cjs'))) {
    throw "Codex claude-mem cache missing for ${Version}: $cacheRoot"
  }
  Apply-RemoteGuard $cacheRoot
  Ensure-PluginRuntimeDependencies $cacheRoot
}

function Ensure-CliVersion([string]$Version) {
  $current = ''
  $cli = Get-CliLauncherPath
  try { $current = [string]((& $cli --version 2>$null | Select-Object -First 1).Trim()) } catch {}
  # UniGetUI no longer independently updates this one npm package. Both CLI and
  # plugins follow the healthy central release, including deliberate rollbacks.
  if ($current -ne $Version) {
    Write-Log "Syncing claude-mem CLI from $current to $Version via $cli"
    Invoke-Checked npm.cmd @('install','-g',"claude-mem@$Version",'--no-fund','--no-audit') | Out-Null
    $after = [string]((& $cli --version 2>$null | Select-Object -First 1).Trim())
    if ($after -ne $Version) { throw "CLI update returned $after instead of $Version" }
    Write-Log "claude-mem CLI is now $Version"
  }
}

function Update-RetainedClientGuards([string]$Version) {
  $policy = Get-Content (Join-Path $MaintenanceDir 'central-client-compatibility.json') -Raw | ConvertFrom-Json
  $compatible = @($policy.captureOnlyPairs | Where-Object worker -eq $Version | Select-Object -ExpandProperty client)
  foreach ($base in @((Join-Path $ClaudeDir 'plugins\cache\thedotmack\claude-mem'),$CodexCacheBase)) {
    Get-ChildItem -LiteralPath $base -Directory -ErrorAction SilentlyContinue | ForEach-Object {
      $package = Join-Path $_.FullName 'package.json'
      if (Test-Path $package) {
        $old = [string](Get-Content $package -Raw | ConvertFrom-Json).version
        if ($old -in $compatible -and (Test-Path (Join-Path $_.FullName 'scripts\worker-service.cjs'))) {
          Apply-RemoteGuard $_.FullName
        }
      }
    }
  }
}

$mutex = New-Object Threading.Mutex($false, 'Local\ClaudeMemCentralVersionSync')
$hasLock = $false
$target = $null
try {
  try { $hasLock = $mutex.WaitOne([TimeSpan]::FromSeconds(3600)) }
  catch [System.Threading.AbandonedMutexException] { $hasLock = $true }
  if (-not $hasLock) { throw 'Timed out waiting for another claude-mem sync; refusing to report false success' }
  Write-Log "Sync check started on $env:COMPUTERNAME ($HomeDir)"
  if ($UpdateCentral) {
    $running = $null
    try { $running = Get-CentralVersion } catch { Write-Log 'Central Worker is unavailable or upgrading; the dispatcher will wait and recheck.' }
    if (-not $running -or (Get-UpdateAction $running $TargetVersion) -eq 'UpdateCentral') {
      Invoke-CentralUpdateCheck
    } else { Write-Log "Central Worker is already $running; only this computer needs synchronization." }
  }
  for ($attempt=1; $attempt -le 3; $attempt++) {
    $target = Get-CentralVersion
    if ($UpdateCentral -and (Get-UpdateAction $target $TargetVersion) -ne 'SyncLocal') { throw "Central Worker $target did not reach requested version $TargetVersion" }
    Write-Log "Central Worker target is $target and ready"
    if ($Initialize) { Initialize-ClientLayout $target }
    Set-RemoteWorkerClientSettings
    Set-LocalMarketplaceSource
    Ensure-MarketplaceVersion $target
    Ensure-ClaudePlugin $target
    Ensure-CodexPlugin $target
    Ensure-CliVersion $target
    Set-RemoteWorkerClientSettings
    $observed = Get-CentralVersion
    if ($observed -eq $target) { break }
    if ($attempt -eq 3) { throw 'Central version changed repeatedly; retry local sync after the upgrade finishes' }
    Write-Log "Another computer changed central $target to $observed; following the new healthy version."
  }
  Update-RetainedClientGuards $target
  Write-Log 'Retrying the official capture outbox; events without an exact acknowledgement remain queued.'
  Invoke-Checked bun @((Join-Path $CodexCacheBase "$target\scripts\worker-service.cjs"),'upload-spool') | Out-Null
  $record = Get-ClaudeInstalledRecord
  $codexRecord = Get-CodexPluginRecord
  $marketVersion = [string](Get-Content -LiteralPath (Join-Path $Marketplace 'plugin\package.json') -Raw | ConvertFrom-Json).version
  $cliVersion = [string]((& (Get-CliLauncherPath) --version 2>$null | Select-Object -First 1).Trim())
  $codexVersion = if ($null -ne $codexRecord) { [string]$codexRecord.version } else { '<missing>' }
  if ($cliVersion -notmatch '^(\d+\.\d+\.\d+)') { throw "invalid npm CLI version after sync: $cliVersion" }
  if ([string]$record.version -ne $target -or $codexVersion -ne $target -or $marketVersion -ne $target -or $cliVersion -ne $target) {
    throw "post-check mismatch: worker=$target claude=$($record.version) codex=$codexVersion marketplace=$marketVersion cli=$cliVersion"
  }
  if ((Get-CentralVersion) -ne $target) { throw 'Central version changed during sync; retry from UniGetUI' }
  Write-JsonAtomic -Path $StatusPath -Object ([ordered]@{schemaVersion=2;status='ok';computer=$env:COMPUTERNAME;profile=$HomeDir;authority=$RemoteWorkerHost;requested=$TargetVersion;worker=$target;cli=$cliVersion;claude=[string]$record.version;codex=$codexVersion;marketplace=$marketVersion;checkedAt=[DateTime]::UtcNow.ToString('o')})
  Write-Log "Sync check OK: worker/Claude/Codex/marketplace=$target; npm CLI=$cliVersion; native hook launcher pinned"
  exit 0
} catch {
  Write-Log "ERROR: $($_.Exception.Message)"
  if ($hasLock) {
    Write-JsonAtomic -Path $StatusPath -Object ([ordered]@{schemaVersion=2;status='error';computer=$env:COMPUTERNAME;profile=$HomeDir;authority=$RemoteWorkerHost;target=$target;error=$_.Exception.Message;retry='Run sync-claude-mem-central.ps1 -SyncLocal to retry this computer without changing the central Worker.';checkedAt=[DateTime]::UtcNow.ToString('o')})
  }
  exit 1
} finally {
  if ($hasLock) { $mutex.ReleaseMutex() | Out-Null }
  $mutex.Dispose()
}

