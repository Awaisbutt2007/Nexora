<#
.SYNOPSIS
  Launch parallel Claude Code agents for Nexora inside herdr, one git worktree per lane.

.USAGE  (run from a pane INSIDE herdr, at the repo root)
  powershell -ExecutionPolicy Bypass -File scripts\herdr-parallel.ps1            # start lanes + send prompts
  powershell -ExecutionPolicy Bypass -File scripts\herdr-parallel.ps1 -NoPrompt  # start agents idle
  powershell -ExecutionPolicy Bypass -File scripts\herdr-parallel.ps1 -Only backend,qa
  powershell -ExecutionPolicy Bypass -File scripts\herdr-parallel.ps1 -Status    # show agent states

  Lanes, branches and prompts live in scripts\herdr-lanes.json.
#>
param(
  [string]$Config = (Join-Path $PSScriptRoot 'herdr-lanes.json'),
  [string[]]$Only = @(),
  [switch]$NoPrompt,
  [switch]$Status
)

$ErrorActionPreference = 'Stop'

if ($env:HERDR_ENV -ne '1') {
  Write-Host "Not running inside herdr. Start 'herdr', open a pane in the Nexora repo, and run this again." -ForegroundColor Red
  exit 1
}

$herdr = (Get-Command herdr -ErrorAction SilentlyContinue).Source
if (-not $herdr) { $herdr = Join-Path $env:LOCALAPPDATA 'Programs\Herdr\bin\herdr.exe' }

function Invoke-Herdr {
  param([string[]]$HerdrArgs)
  $out = & $herdr @HerdrArgs 2>&1
  $code = $LASTEXITCODE
  $text = ($out | ForEach-Object { "$_" }) -join "`n"
  if ($code -ne 0) { throw "herdr $($HerdrArgs -join ' ') failed ($code): $text" }
  if ($text.Trim().StartsWith('{')) { return ($text | ConvertFrom-Json) }
  return $text
}

# Depth-first search for the first 'pane_id' in a herdr JSON response.
function Find-PaneId($node) {
  if ($null -eq $node) { return $null }
  if ($node -is [System.Management.Automation.PSCustomObject]) {
    foreach ($key in @('root_pane', 'pane')) {
      $p = $node.PSObject.Properties[$key]
      if ($p -and $p.Value -and $p.Value.pane_id) { return $p.Value.pane_id }
    }
    if ($node.PSObject.Properties['pane_id']) { return $node.pane_id }
    foreach ($p in $node.PSObject.Properties) {
      $found = Find-PaneId $p.Value
      if ($found) { return $found }
    }
  } elseif ($node -is [System.Array]) {
    foreach ($item in $node) { $found = Find-PaneId $item; if ($found) { return $found } }
  }
  return $null
}

if ($Status) {
  & $herdr agent list
  exit $LASTEXITCODE
}

$repo = (git rev-parse --show-toplevel).Trim()
$cfg = Get-Content $Config -Raw | ConvertFrom-Json
$wtRoot = [System.IO.Path]::GetFullPath((Join-Path $repo $cfg.worktreeRoot))
New-Item -ItemType Directory -Force $wtRoot | Out-Null

$lanes = @($cfg.lanes)
if ($Only.Count -gt 0) { $lanes = @($lanes | Where-Object { $Only -contains $_.name }) }

$started = @()
foreach ($lane in $lanes) {
  $name = $lane.name
  $path = Join-Path $wtRoot $name
  Write-Host "==> [$name] $($lane.branch) -> $path" -ForegroundColor Cyan

  try {
    # 1. Worktree + herdr workspace (reuse it if it already exists)
    if (Test-Path $path) {
      $res = Invoke-Herdr @('worktree', 'open', '--cwd', $repo, '--path', $path, '--label', $name, '--no-focus')
    } else {
      $branchExists = (git -C $repo branch --list $lane.branch)
      if ($branchExists) {
        git -C $repo worktree add $path $lane.branch | Out-Null
        $res = Invoke-Herdr @('worktree', 'open', '--cwd', $repo, '--path', $path, '--label', $name, '--no-focus')
      } else {
        $res = Invoke-Herdr @('worktree', 'create', '--cwd', $repo, '--branch', $lane.branch, '--base', $cfg.base,
                              '--path', $path, '--label', $name, '--no-focus')
      }
    }
    $paneId = Find-PaneId $res
    if (-not $paneId) { throw "could not read the pane id from herdr's response: $($res | ConvertTo-Json -Depth 8)" }

    # 2. Copy local (gitignored) env files so the lane can actually run the app/tests
    foreach ($rel in @($cfg.copyEnvFiles)) {
      $src = Join-Path $repo $rel
      $dst = Join-Path $path $rel
      if ((Test-Path $src) -and -not (Test-Path $dst)) { Copy-Item $src $dst }
    }

    # 3. Start Claude Code in that pane
    $startArgs = @('agent', 'start', $name, '--kind', 'claude', '--pane', $paneId, '--timeout', '60000')
    if ($cfg.claudeArgs) { $startArgs += @('--') + @($cfg.claudeArgs) }
    try {
      Invoke-Herdr $startArgs | Out-Null
    } catch {
      if ("$_" -match 'agent_not_ready') {
        Write-Host "    [$name] Claude is waiting on a dialog (probably 'trust this folder'). Answer it in that pane, then run: herdr agent prompt $name `"<task>`"" -ForegroundColor Yellow
        continue
      }
      throw
    }

    # 4. Hand it the task (no --wait, so every lane runs in parallel)
    if (-not $NoPrompt -and $lane.prompt) {
      Invoke-Herdr @('agent', 'prompt', $name, $lane.prompt) | Out-Null
      Write-Host "    [$name] started and prompted (pane $paneId)" -ForegroundColor Green
    } else {
      Write-Host "    [$name] started idle (pane $paneId)" -ForegroundColor Green
    }
    $started += $name
  } catch {
    Write-Host "    [$name] FAILED: $_" -ForegroundColor Red
  }
}

Write-Host ""
Write-Host "Running lanes: $($started -join ', ')" -ForegroundColor Cyan
Write-Host "  herdr agent list                                   # status of every agent"
Write-Host "  herdr agent wait <lane> --timeout 1800000          # wait for one lane to finish"
Write-Host "  herdr agent read <lane> --source recent-unwrapped --lines 120"
Write-Host "  Ctrl+B w                                           # switch between lane workspaces"
Write-Host "When a lane is done, review and merge from the main repo:"
Write-Host "  git log main..agent/<lane> --oneline ; git diff main...agent/<lane> ; git merge agent/<lane>"
