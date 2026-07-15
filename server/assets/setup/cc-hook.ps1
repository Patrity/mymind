#Requires -Version 5.1
# mymind cc-hook (PowerShell) — POSTs Claude Code session events + transcript deltas to MyMind.
# Install: New-Item -ItemType Directory -Force "$HOME\.mymind" | Out-Null
#          Invoke-WebRequest "$env:MYMIND_URL/api/setup/cc-hook.ps1" -OutFile "$HOME\.mymind\cc-hook.ps1"
# Wire into %USERPROFILE%\.claude\settings.json hooks as:
#   powershell -NoProfile -ExecutionPolicy Bypass -File "%USERPROFILE%\.mymind\cc-hook.ps1" <EventName>
# Best-effort: never throws, always exits 0. POSTs use short timeouts so a hook can't
# hang the agent for long (Windows PowerShell 5.1 has no cheap background dispatch).
param([string]$EventName = 'unknown')
$ErrorActionPreference = 'SilentlyContinue'
$ProgressPreference = 'SilentlyContinue'

$cfgdir = Join-Path $HOME '.mymind'
$cfg    = Join-Path $cfgdir 'config.env'
$log    = Join-Path $cfgdir 'cc-hook.log'
$offdir = Join-Path $cfgdir 'transcript-offsets'
$midf   = Join-Path $cfgdir 'machine_id'
New-Item -ItemType Directory -Force $offdir | Out-Null

# load config.env (KEY=VALUE) into env for any keys not already set
if (Test-Path $cfg) {
  foreach ($line in Get-Content $cfg) {
    if ($line -match '^\s*([^=#]+)=(.*)$') {
      $k = $matches[1].Trim(); $v = $matches[2].Trim()
      if (-not [Environment]::GetEnvironmentVariable($k)) { Set-Item "env:$k" $v }
    }
  }
}
$url = $env:MYMIND_URL
$tok = $env:MYMIND_TOKEN
if (-not $url -or -not $tok) { exit 0 }   # not configured — silent no-op

# stable machine id
if (-not (Test-Path $midf) -or -not (Get-Content $midf -Raw)) {
  [guid]::NewGuid().ToString() | Set-Content -NoNewline $midf
}
$mid   = (Get-Content $midf -Raw).Trim()
$hostn = $env:COMPUTERNAME

# read hook payload from stdin
$payload = '{}'
if ([Console]::IsInputRedirected) { $payload = [Console]::In.ReadToEnd() }
if (-not $payload) { $payload = '{}' }
$sid = ''; $tp = ''; $cwd = ''
try {
  $d = $payload | ConvertFrom-Json
  if ($d.session_id) { $sid = $d.session_id } elseif ($d.sessionId) { $sid = $d.sessionId }
  if ($d.transcript_path) { $tp = $d.transcript_path }
  if ($d.cwd) { $cwd = $d.cwd }
} catch { }

# git context (never fails)
$gb = ''; $gc = ''; $gr = ''; $proj = ''
if ($cwd -and (Test-Path $cwd)) {
  $gb = (git -C $cwd rev-parse --abbrev-ref HEAD 2>$null)
  $gc = (git -C $cwd rev-parse HEAD 2>$null)
  $gr = (git -C $cwd config --get remote.origin.url 2>$null)
  $proj = Split-Path $cwd -Leaf
}

function NullIfEmpty($s) { if ($s) { $s } else { $null } }

# always POST the event itself (short timeout; swallow errors)
if ($sid) {
  $body = @{
    source      = 'claude_code'
    external_id = $sid
    project     = (NullIfEmpty $proj)
    cwd         = (NullIfEmpty $cwd)
    git_branch  = (NullIfEmpty $gb)
    git_commit  = (NullIfEmpty $gc)
    git_remote  = (NullIfEmpty $gr)
    machine_id  = $mid
    hostname    = $hostn
    metadata    = @{ hostname = $hostn; lastEvent = $EventName }
  } | ConvertTo-Json -Compress -Depth 5
  try {
    Invoke-RestMethod -Method Post -Uri "$url/api/hooks/cc/$EventName" -TimeoutSec 5 `
      -ContentType 'application/json' -Headers @{ Authorization = "Bearer $tok" } -Body $body | Out-Null
  } catch {
    $code = if ($_.Exception.Response) { [int]$_.Exception.Response.StatusCode.value__ } else { 0 }
    "$([DateTime]::Now.ToString('u')) event=$EventName POST failed http=$code" | Add-Content $log
  }
}

# ship transcript delta on terminal events
if (($EventName -in @('Stop', 'SubagentStop', 'SessionEnd')) -and $sid -and $tp -and (Test-Path $tp)) {
  $offf = Join-Path $offdir "$sid.off"
  $prev = 0
  if (Test-Path $offf) { [void][int]::TryParse(((Get-Content $offf -Raw).Trim()), [ref]$prev) }
  $size = (Get-Item $tp).Length
  if ($prev -gt $size) { $prev = 0 }   # rotated/truncated
  if ($size -gt $prev) {
    $MAX = 4194304   # 4 MB cap per shipment
    $toRead = [int][Math]::Min([long]($size - $prev), [long]$MAX)
    $buf = New-Object byte[] $toRead
    $read = 0
    $fs = [System.IO.File]::Open($tp, [System.IO.FileMode]::Open, [System.IO.FileAccess]::Read, [System.IO.FileShare]::ReadWrite)
    try {
      [void]$fs.Seek($prev, [System.IO.SeekOrigin]::Begin)
      $read = $fs.Read($buf, 0, $toRead)
    } finally { $fs.Close() }
    if ($read -gt 0) {
      # advance only by complete lines (last newline in the window)
      $lastNl = [Array]::LastIndexOf($buf, [byte]10, $read - 1)
      $consumed = if ($lastNl -ge 0) { $lastNl + 1 } else { 0 }
      if ($consumed -gt 0) {
        $text = [System.Text.Encoding]::UTF8.GetString($buf, 0, $consumed)
        $lines = @($text -split "`n" | Where-Object { $_.Trim() -ne '' })
        $tbody = @{ source = 'claude_code'; external_id = $sid; lines = $lines } | ConvertTo-Json -Compress -Depth 4
        try {
          Invoke-RestMethod -Method Post -Uri "$url/api/hooks/cc/transcript" -TimeoutSec 15 `
            -ContentType 'application/json' -Headers @{ Authorization = "Bearer $tok" } -Body $tbody | Out-Null
          ($prev + $consumed) | Set-Content -NoNewline $offf
        } catch {
          # offset advance sits after the POST inside try, so a non-2xx skips it → retried next terminal event
          $code = if ($_.Exception.Response) { [int]$_.Exception.Response.StatusCode.value__ } else { 0 }
          "$([DateTime]::Now.ToString('u')) transcript POST failed http=$code sid=$sid" | Add-Content $log
        }
      }
    }
  }
}
exit 0
