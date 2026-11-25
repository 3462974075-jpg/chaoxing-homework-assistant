# Chaoxing Homework Assistant v1.5.0
# Copyright (c) 2026 sevenplayer (Lsy). All rights reserved.
# SPDX-License-Identifier: MIT
# Powered by DeepSeek (AI-assisted development)

<#
  ChaoxingHomework - one-time environment preparation for the portable
  (green / no-install) edition.
  ------------------------------------------------------------------------
  This script ONLY writes inside the program directory:
      <root>\runtime\node\   portable Node.js
      <root>\dsh\            DSH CLI installed with npm --prefix
      <root>\data\           cache / temp / progress
      <root>\logs\           logs
  It never touches the system PATH, the registry, or the user's global npm
  directory and never requires administrator rights.
  ------------------------------------------------------------------------
  This file is intentionally pure ASCII (Windows PowerShell 5.1 reads .ps1
  as ANSI). Chinese text lives in messages.json (UTF-8).
  ------------------------------------------------------------------------
  Machine-readable output (when stdout is redirected or -Machine is given):
      STEP|<index>|<total>|<stepId>|<running|done|skipped|warning|failed>
      DONE|<dshVersion>
      FAIL|<reason>
  Step ids: root, node, dsh
#>
[CmdletBinding()]
param(
    [string]$AppRoot = '',
    [string]$Root = '',
    [switch]$ForceNode,
    [switch]$ForceDsh,
    [switch]$OnlyDsh,
    [switch]$NoDsh,
    [switch]$Machine,
    [string]$Registry = '',
    [string]$NodeUrl = '',
    [string]$NodeMirrorUrl = '',
    [string]$NodeVersion = 'v24.21.0',
    [switch]$Help
)

$ErrorActionPreference = 'Continue'
$RootRequested = $Root
$script:Utf8 = New-Object System.Text.UTF8Encoding($false)
$script:Messages = $null
$script:Root = ''
$script:DataDir = ''
$script:LogDir = ''
$script:RuntimeDir = ''
$script:DshDir = ''
$script:LogFile = ''
$script:ProgressFile = ''
$script:History = New-Object System.Collections.ArrayList
$script:StepIndex = 0
$script:TotalSteps = 3
$script:CurrentStepId = ''
$script:StepStatus = 'done'
$script:StartedAt = (Get-Date)
$script:NodeInfo = $null
$script:NodeSource = ''
$script:DshVersion = ''
$script:MachineMode = $false

if (-not [Console]::IsOutputRedirected) {
    $script:MachineMode = [bool]$Machine
} else {
    $script:MachineMode = $true
}
if ($script:MachineMode) {
    try { [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false) } catch { }
}

# ---------------------------------------------------------------------------
# Messages
# ---------------------------------------------------------------------------
function Initialize-Messages {
    $candidates = New-Object System.Collections.ArrayList
    [void]$candidates.Add((Join-Path $PSScriptRoot 'messages.json'))
    $parent = Split-Path -Path $PSScriptRoot -Parent
    if ($parent) {
        [void]$candidates.Add((Join-Path $parent 'messages.json'))
        [void]$candidates.Add((Join-Path $parent 'bootstrap\messages.json'))
    }
    foreach ($candidate in $candidates) {
        if (Test-Path -LiteralPath $candidate) {
            $raw = Get-Content -LiteralPath $candidate -Raw -Encoding UTF8
            $script:Messages = $raw | ConvertFrom-Json
            return
        }
    }
    throw 'messages.json not found next to prepare.ps1'
}

function Get-Msg {
    param([string]$Key, [object[]]$Fmt = @())
    if ($null -eq $script:Messages) { return $Key }
    $node = $script:Messages
    foreach ($part in $Key.Split('.')) {
        if ($null -eq $node) { return $Key }
        $node = $node.$part
    }
    if ($null -eq $node) { return $Key }
    $text = [string]$node
    if ($null -ne $Fmt -and $Fmt.Count -gt 0) {
        try { $text = $text -f $Fmt } catch { }
    }
    return $text
}

# ---------------------------------------------------------------------------
# Logging / progress
# ---------------------------------------------------------------------------
function Write-Log {
    param([string]$Text = '', [string]$Color = 'Gray')
    if ($Text -eq '') {
        try { Write-Host '' } catch { }
    } else {
        try { Write-Host $Text -ForegroundColor $Color } catch { Write-Host $Text }
    }
    if ($script:LogFile -ne '') {
        try { [System.IO.File]::AppendAllText($script:LogFile, $Text + "`r`n", $script:Utf8) } catch { }
    }
}

function Write-Msg {
    param([string]$Key, [object[]]$Fmt = @(), [string]$Color = 'Gray')
    Write-Log (Get-Msg -Key $Key -Fmt $Fmt) $Color
}

function Write-MachineLine {
    param([string]$Line)
    if (-not $script:MachineMode) { return }
    try {
        [Console]::Out.WriteLine($Line)
        [Console]::Out.Flush()
    } catch { }
    if ($script:LogFile -ne '') {
        try { [System.IO.File]::AppendAllText($script:LogFile, $Line + "`r`n", $script:Utf8) } catch { }
    }
}

function Write-ProgressLine {
    param([string]$StepId, [string]$Status)
    Write-MachineLine ('STEP|' + $script:StepIndex + '|' + $script:TotalSteps + '|' + $StepId + '|' + $Status)
}

function Set-Progress {
    param([string]$Step, [string]$Status, [string]$Message)
    if ($script:ProgressFile -eq '') { return }
    $ts = (Get-Date).ToString('yyyy-MM-ddTHH:mm:sszzz')
    $entry = [PSCustomObject]@{ step = $Step; status = $Status; message = $Message; ts = $ts }
    [void]$script:History.Add($entry)
    $obj = [PSCustomObject]@{
        step      = $Step
        status    = $Status
        message   = $Message
        ts        = $ts
        root      = $script:Root
        pid       = $PID
        mode      = 'prepare'
        startedAt = $script:StartedAt.ToString('yyyy-MM-ddTHH:mm:sszzz')
        updatedAt = $ts
        history   = @($script:History)
    }
    try {
        $json = $obj | ConvertTo-Json -Depth 6
        [System.IO.File]::WriteAllText($script:ProgressFile, $json, $script:Utf8)
    } catch { }
}

# ---------------------------------------------------------------------------
# Utilities
# ---------------------------------------------------------------------------
function Write-NewText {
    param([string]$Path, [long]$Position = 0)
    $result = @{ text = ''; position = $Position }
    if (-not (Test-Path -LiteralPath $Path)) { return $result }
    $stream = $null
    $reader = $null
    try {
        $stream = [System.IO.File]::Open($Path, [System.IO.FileMode]::Open, [System.IO.FileAccess]::Read, [System.IO.FileShare]::ReadWrite)
        if ($stream.Length -le $Position) { return $result }
        [void]$stream.Seek($Position, [System.IO.SeekOrigin]::Begin)
        $reader = New-Object System.IO.StreamReader($stream, [System.Text.Encoding]::UTF8, $true)
        $result.text = [string]$reader.ReadToEnd()
        $result.position = $stream.Length
    } catch {
    } finally {
        if ($reader) { try { $reader.Dispose() } catch { } }
        elseif ($stream) { try { $stream.Dispose() } catch { } }
    }
    return $result
}

function Invoke-ExeText {
    param([string]$Exe, [string[]]$ExeArgs = @())
    $text = ''
    $code = -1
    try {
        $out = & $Exe @ExeArgs 2>&1 | ForEach-Object { [string]$_ }
        $text = ($out -join "`n")
        $code = $LASTEXITCODE
    } catch {
        $text = [string]$_.Exception.Message
        $code = -1
    }
    return @{ code = $code; text = $text }
}

function Invoke-CmdCapture {
    param([string]$CmdPath, [string]$ArgString = '', [string]$OutFile = '')
    $result = @{ code = -1; text = ''; logFile = $OutFile }
    if ($OutFile -eq '') {
        $tmpDir = Join-Path $script:DataDir 'tmp'
        if (-not (Test-Path -LiteralPath $tmpDir)) { [void](New-Item -ItemType Directory -Path $tmpDir -Force -ErrorAction SilentlyContinue) }
        $OutFile = Join-Path $tmpDir ('cmd-' + [Guid]::NewGuid().ToString('N') + '.log')
        $result.logFile = $OutFile
    }
    try {
        $psi = New-Object System.Diagnostics.ProcessStartInfo
        $psi.FileName = (Join-Path $env:SystemRoot 'System32\cmd.exe')
        $psi.Arguments = '/d /s /c ""' + $CmdPath + '" ' + $ArgString + ' > "' + $OutFile + '" 2>&1"'
        $psi.UseShellExecute = $false
        $psi.CreateNoWindow = $true
        $psi.WorkingDirectory = $script:Root
        $proc = [System.Diagnostics.Process]::Start($psi)
        $proc.WaitForExit()
        $result.code = $proc.ExitCode
        if (Test-Path -LiteralPath $OutFile) {
            try { $result.text = [string](Get-Content -LiteralPath $OutFile -Raw -Encoding UTF8) } catch { }
        }
    } catch {
        $result.code = -1
        $result.text = [string]$_.Exception.Message
    }
    return $result
}

function Test-DirWritable {
    param([string]$Dir)
    $probe = Join-Path $Dir ('.write-test-' + [Guid]::NewGuid().ToString('N') + '.tmp')
    try {
        [System.IO.File]::WriteAllText($probe, 'ok')
        Remove-Item -LiteralPath $probe -Force -ErrorAction SilentlyContinue
        return $true
    } catch {
        return $false
    }
}

function Get-NodeArch {
    if ($env:PROCESSOR_ARCHITECTURE -eq 'ARM64') { return 'win-arm64' }
    return 'win-x64'
}

function Get-NodeInfo {
    param([string]$Exe)
    if (-not $Exe) { return $null }
    if (-not (Test-Path -LiteralPath $Exe)) { return $null }
    $res = Invoke-ExeText -Exe $Exe -ExeArgs @('--version')
    if ($res.code -ne 0) { return $null }
    $text = ([string]$res.text).Trim()
    if ($text -match 'v?(\d+)\.(\d+)\.(\d+)') {
        $major = [int]$Matches[1]
        $minor = [int]$Matches[2]
        $patch = [int]$Matches[3]
        return [PSCustomObject]@{
            path    = $Exe
            version = ('v' + $major + '.' + $minor + '.' + $patch)
            major   = $major
            minor   = $minor
            patch   = $patch
        }
    }
    return $null
}

function Find-SystemNode {
    $candidates = New-Object System.Collections.ArrayList
    $cmd = Get-Command 'node.exe' -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($cmd) { [void]$candidates.Add($cmd.Source) }
    if ($env:ProgramFiles) { [void]$candidates.Add((Join-Path $env:ProgramFiles 'nodejs\node.exe')) }
    if (${env:ProgramFiles(x86)}) { [void]$candidates.Add((Join-Path ${env:ProgramFiles(x86)} 'nodejs\node.exe')) }
    if ($env:LOCALAPPDATA) { [void]$candidates.Add((Join-Path $env:LOCALAPPDATA 'Programs\nodejs\node.exe')) }
    foreach ($candidate in $candidates) {
        if ($candidate -and (Test-Path -LiteralPath $candidate)) {
            $info = Get-NodeInfo -Exe $candidate
            if ($info) { return $info }
        }
    }
    return $null
}

function Find-NpmCmd {
    $candidates = New-Object System.Collections.ArrayList
    if ($script:NodeInfo -and $script:NodeInfo.path) {
        [void]$candidates.Add((Join-Path (Split-Path -Path $script:NodeInfo.path -Parent) 'npm.cmd'))
    }
    $cmd = Get-Command 'npm.cmd' -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($cmd) { [void]$candidates.Add($cmd.Source) }
    if ($env:ProgramFiles) { [void]$candidates.Add((Join-Path $env:ProgramFiles 'nodejs\npm.cmd')) }
    if (${env:ProgramFiles(x86)}) { [void]$candidates.Add((Join-Path ${env:ProgramFiles(x86)} 'nodejs\npm.cmd')) }
    if ($env:LOCALAPPDATA) { [void]$candidates.Add((Join-Path $env:LOCALAPPDATA 'Programs\nodejs\npm.cmd')) }
    foreach ($candidate in $candidates) {
        if ($candidate -and (Test-Path -LiteralPath $candidate)) { return $candidate }
    }
    return ''
}

function Set-NodePath {
    if (-not $script:NodeInfo -or -not $script:NodeInfo.path) { return }
    $nodeDir = Split-Path -Path $script:NodeInfo.path -Parent
    $already = $false
    foreach ($part in ($env:PATH -split ';')) {
        if ($part -and $part.TrimEnd('\') -ieq $nodeDir.TrimEnd('\')) { $already = $true }
    }
    if (-not $already) { $env:PATH = $nodeDir + ';' + $env:PATH }
}

# ---------------------------------------------------------------------------
# Root / log
# ---------------------------------------------------------------------------
function Resolve-Root {
    $envRoot = [Environment]::GetEnvironmentVariable('CX_APP_ROOT')
    $chosen = ''
    if ($AppRoot -ne '') { $chosen = $AppRoot }
    elseif ($RootRequested -ne '') { $chosen = $RootRequested }
    elseif ($envRoot) { $chosen = $envRoot }
    else { $chosen = $PSScriptRoot }
    $chosen = [Environment]::ExpandEnvironmentVariables($chosen)
    if (-not [System.IO.Path]::IsPathRooted($chosen)) { $chosen = Join-Path (Get-Location).Path $chosen }
    return ([System.IO.Path]::GetFullPath($chosen)).TrimEnd('\')
}

function Initialize-Log {
    $stamp = $script:StartedAt.ToString('yyyyMMdd-HHmmss')
    $script:LogFile = Join-Path $script:LogDir ('prepare-' + $stamp + '.log')
    $script:ProgressFile = Join-Path $script:DataDir 'install-progress.json'
    $header = New-Object System.Collections.ArrayList
    [void]$header.Add('==== ChaoxingHomework prepare log ====')
    [void]$header.Add('time: ' + (Get-Date).ToString('yyyy-MM-dd HH:mm:ss'))
    [void]$header.Add('root: ' + $script:Root)
    [void]$header.Add('ps  : ' + $PSVersionTable.PSVersion.ToString())
    [void]$header.Add('os  : ' + [Environment]::OSVersion.VersionString)
    [void]$header.Add('arch: ' + $env:PROCESSOR_ARCHITECTURE)
    [void]$header.Add('args: ' + [string]$MyInvocation.Line)
    [void]$header.Add('======================================')
    foreach ($line in $header) {
        try { [System.IO.File]::AppendAllText($script:LogFile, $line + "`r`n", $script:Utf8) } catch { }
    }
}

# ---------------------------------------------------------------------------
# Download helpers (Invoke-WebRequest -> curl.exe -> node fetch)
# ---------------------------------------------------------------------------
function Try-DownloadWebRequest {
    param([string]$Url, [string]$Dest)
    $ProgressPreference = 'SilentlyContinue'
    try {
        try { [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12 } catch { }
        Invoke-WebRequest -Uri $Url -OutFile $Dest -UseBasicParsing -TimeoutSec 900 -ErrorAction Stop
        return @{ ok = (Test-Path -LiteralPath $Dest); error = '' }
    } catch {
        return @{ ok = $false; error = [string]$_.Exception.Message }
    }
}

function Try-DownloadCurl {
    param([string]$Url, [string]$Dest)
    $curl = Join-Path $env:SystemRoot 'System32\curl.exe'
    if (-not (Test-Path -LiteralPath $curl)) { return @{ ok = $false; error = 'curl.exe not found' } }
    try {
        & $curl -L --fail --retry 1 --connect-timeout 30 --max-time 900 -o $Dest $Url 2>&1 | ForEach-Object { }
        $code = $LASTEXITCODE
        return @{ ok = (($code -eq 0) -and (Test-Path -LiteralPath $Dest)); error = ('curl exit code ' + $code) }
    } catch {
        return @{ ok = $false; error = [string]$_.Exception.Message }
    }
}

function Try-DownloadNode {
    param([string]$Url, [string]$Dest)
    $nodeExe = ''
    if ($script:NodeInfo -and $script:NodeInfo.path -and (Test-Path -LiteralPath $script:NodeInfo.path)) {
        $nodeExe = $script:NodeInfo.path
    } else {
        $systemNode = Find-SystemNode
        if ($systemNode) { $nodeExe = $systemNode.path }
    }
    if ($nodeExe -eq '') { return @{ ok = $false; error = 'node not available for fallback download' } }
    # The download helper is written to a real .js file: passing JS code with
    # embedded quotes through -e would be mangled by the native argument
    # parser of Windows PowerShell 5.1.
    $tmpDir = Join-Path $script:DataDir 'tmp'
    if (-not (Test-Path -LiteralPath $tmpDir)) { [void](New-Item -ItemType Directory -Path $tmpDir -Force -ErrorAction SilentlyContinue) }
    $jsPath = Join-Path $tmpDir ('download-' + [Guid]::NewGuid().ToString('N') + '.cjs')
    $js = @'
const fs = require("fs");
const url = process.argv[2];
const out = process.argv[3];
fetch(url).then(async (r) => {
  if (!r.ok) throw new Error("HTTP " + r.status);
  const buf = Buffer.from(await r.arrayBuffer());
  fs.writeFileSync(out, buf);
  console.log("downloaded " + buf.length);
  process.exit(0);
}).catch((e) => {
  console.error("ERR " + e.message);
  process.exit(1);
});
'@
    try {
        [System.IO.File]::WriteAllText($jsPath, $js, $script:Utf8)
        $lines = & $nodeExe $jsPath $Url $Dest 2>&1 | ForEach-Object { [string]$_ }
        $code = $LASTEXITCODE
        foreach ($line in $lines) { Write-Log ('  ' + $line) 'DarkGray' }
        return @{ ok = (($code -eq 0) -and (Test-Path -LiteralPath $Dest)); error = (($lines -join ' ') + ' / exit ' + $code) }
    } catch {
        return @{ ok = $false; error = [string]$_.Exception.Message }
    } finally {
        Remove-Item -LiteralPath $jsPath -Force -ErrorAction SilentlyContinue
    }
}

function Download-WithFallback {
    param([string]$Url, [string]$Dest)
    $methods = @(
        @{ name = 'Invoke-WebRequest'; fn = 'Try-DownloadWebRequest' },
        @{ name = 'curl.exe'; fn = 'Try-DownloadCurl' },
        @{ name = 'node-fetch'; fn = 'Try-DownloadNode' }
    )
    $lastError = ''
    foreach ($method in $methods) {
        if (Test-Path -LiteralPath $Dest) { Remove-Item -LiteralPath $Dest -Force -ErrorAction SilentlyContinue }
        Write-Log ('  downloading via ' + $method.name + ' ...') 'DarkGray'
        $res = & $method.fn -Url $Url -Dest $Dest
        if ($res.ok) {
            $size = 0
            try { $size = (Get-Item -LiteralPath $Dest).Length } catch { }
            if ($size -gt 1024) { return @{ ok = $true; error = ''; method = $method.name } }
        }
        $lastError = $method.name + ': ' + $res.error
        Write-Msg 'prepare.node.attemptFail' @($lastError) 'DarkGray'
    }
    return @{ ok = $false; error = $lastError; method = '' }
}

function Test-ZipFile {
    param([string]$Path)
    try {
        $bytes = New-Object byte[] 2
        $fs = [System.IO.File]::OpenRead($Path)
        try { [void]$fs.Read($bytes, 0, 2) } finally { $fs.Dispose() }
        if ($bytes[0] -eq 0x50 -and $bytes[1] -eq 0x4B) { return $true }
        return $false
    } catch {
        return $false
    }
}

function Expand-ZipArchive {
    param([string]$ZipPath, [string]$DestDir)
    if (Test-Path -LiteralPath $DestDir) {
        Remove-Item -LiteralPath $DestDir -Recurse -Force -ErrorAction SilentlyContinue
    }
    [void](New-Item -ItemType Directory -Path $DestDir -Force -ErrorAction SilentlyContinue)
    $dotnetError = ''
    try {
        Add-Type -AssemblyName 'System.IO.Compression.FileSystem' -ErrorAction Stop
        [System.IO.Compression.ZipFile]::ExtractToDirectory($ZipPath, $DestDir)
        return
    } catch {
        $dotnetError = [string]$_.Exception.Message
        Write-Log ('  .NET unzip failed: ' + $dotnetError) 'DarkGray'
    }
    if (Test-Path -LiteralPath $DestDir) {
        Remove-Item -LiteralPath $DestDir -Recurse -Force -ErrorAction SilentlyContinue
    }
    try {
        Expand-Archive -Path $ZipPath -DestinationPath $DestDir -Force -ErrorAction Stop
    } catch {
        throw (Get-Msg 'prepare.node.extractFail' @(([string]$_.Exception.Message) + ' / ' + $dotnetError))
    }
}

# ---------------------------------------------------------------------------
# Steps
# ---------------------------------------------------------------------------
function Invoke-Step {
    param([string]$StepId, [string]$TitleKey, [scriptblock]$Body)
    $script:StepIndex = $script:StepIndex + 1
    $script:CurrentStepId = $StepId
    $script:StepStatus = 'done'
    Write-ProgressLine -StepId $StepId -Status 'running'
    Write-Log ''
    Write-Msg $TitleKey @() 'Cyan'
    Set-Progress $StepId 'running' (Get-Msg $TitleKey)
    try {
        & $Body | Out-Null
    } catch {
        Write-ProgressLine -StepId $StepId -Status 'failed'
        Set-Progress $StepId 'failed' ([string]$_.Exception.Message)
        throw
    }
    Write-ProgressLine -StepId $StepId -Status $script:StepStatus
}

function Step-Root {
    $dirs = @(
        $script:Root,
        (Join-Path $script:Root 'runtime'),
        $script:RuntimeDir,
        (Join-Path $script:Root 'dsh'),
        (Join-Path $script:Root 'app'),
        $script:DataDir,
        $script:LogDir,
        (Join-Path $script:DataDir 'tmp'),
        (Join-Path $script:DataDir 'npm-cache')
    )
    foreach ($dir in $dirs) {
        if (-not (Test-Path -LiteralPath $dir)) {
            try {
                [void](New-Item -ItemType Directory -Path $dir -Force -ErrorAction Stop)
                Write-Msg 'prepare.root.create' @($dir) 'DarkGray'
            } catch {
                throw (Get-Msg 'prepare.root.notWritable' @($dir))
            }
        }
    }
    if (-not (Test-DirWritable -Dir $script:Root)) {
        throw (Get-Msg 'prepare.root.notWritable' @($script:Root))
    }
    if (-not (Test-DirWritable -Dir $script:DataDir)) {
        throw (Get-Msg 'prepare.root.notWritable' @($script:DataDir))
    }
    Write-Msg 'prepare.root.ready' @() 'Green'
    Set-Progress 'root' 'done' (Get-Msg 'prepare.root.ready')
}

function Step-Node {
    Write-Msg 'prepare.node.check' @() 'Gray'
    $portableExe = Join-Path (Join-Path $script:RuntimeDir 'node') 'node.exe'
    if (Test-Path -LiteralPath $portableExe) {
        $existing = Get-NodeInfo -Exe $portableExe
        if ($existing -and $existing.major -ge 22 -and -not $ForceNode) {
            $script:NodeInfo = $existing
            $script:NodeSource = Get-Msg 'prepare.node.sourcePortable'
            Write-Msg 'prepare.node.found' @($existing.version, $portableExe) 'Green'
            Set-Progress 'node' 'skipped' (Get-Msg 'prepare.node.found' @($existing.version, $portableExe))
            $script:StepStatus = 'skipped'
            Set-NodePath
            return
        }
        if ($existing) { Write-Log ('  existing portable node: ' + $existing.version + ' / forced reinstall') 'DarkGray' }
    }
    Write-Msg 'prepare.node.need' @($NodeVersion) 'Gray'
    Write-Msg 'prepare.node.arch' @((Get-NodeArch)) 'DarkGray'
    $urls = New-Object System.Collections.ArrayList
    $zipName = 'node-' + $NodeVersion + '-' + (Get-NodeArch) + '.zip'
    if ($NodeUrl -ne '') { [void]$urls.Add($NodeUrl) } else { [void]$urls.Add('https://nodejs.org/dist/' + $NodeVersion + '/' + $zipName) }
    if ($NodeMirrorUrl -ne '') { [void]$urls.Add($NodeMirrorUrl) } else { [void]$urls.Add('https://npmmirror.com/mirrors/node/' + $NodeVersion + '/' + $zipName) }
    $zipPath = Join-Path $script:DataDir $zipName
    $downloadOk = $false
    $lastError = ''
    $index = 0
    foreach ($url in $urls) {
        $index = $index + 1
        if ($index -gt 1) { Write-Msg 'prepare.node.mirror' @($url) 'Yellow' }
        Write-Msg 'prepare.node.downloadStart' @($NodeVersion) 'Gray'
        Write-Msg 'prepare.node.downloadUrl' @($url) 'DarkGray'
        $timer = [System.Diagnostics.Stopwatch]::StartNew()
        $res = Download-WithFallback -Url $url -Dest $zipPath
        $timer.Stop()
        if ($res.ok) {
            $downloadOk = $true
            $sizeMb = [math]::Round(((Get-Item -LiteralPath $zipPath).Length / 1MB), 1)
            Write-Msg 'prepare.node.downloadOk' @($zipPath, $sizeMb, [int]$timer.Elapsed.TotalSeconds) 'Green'
            break
        }
        $lastError = [string]$res.error
        Write-Msg 'prepare.node.attemptFail' @($lastError) 'Yellow'
        Set-Progress 'node' 'warning' (Get-Msg 'prepare.node.attemptFail' @($lastError))
    }
    if (-not $downloadOk) { throw (Get-Msg 'prepare.node.downloadFail' @($lastError)) }
    if (-not (Test-ZipFile -Path $zipPath)) { throw (Get-Msg 'prepare.node.badZip' @($zipPath)) }
    Write-Msg 'prepare.node.extractStart' @() 'Gray'
    $extractDir = Join-Path $script:DataDir 'node-extract'
    Expand-ZipArchive -ZipPath $zipPath -DestDir $extractDir
    $inner = Get-ChildItem -LiteralPath $extractDir -Directory -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($null -eq $inner) { throw (Get-Msg 'prepare.node.extractFail' @('no folder inside the zip archive')) }
    $targetDir = Join-Path $script:RuntimeDir 'node'
    if (Test-Path -LiteralPath $targetDir) {
        Remove-Item -LiteralPath $targetDir -Recurse -Force -ErrorAction SilentlyContinue
    }
    try {
        [System.IO.Directory]::Move($inner.FullName, $targetDir)
    } catch {
        throw (Get-Msg 'prepare.node.extractFail' @([string]$_.Exception.Message))
    }
    Write-Msg 'prepare.node.extractOk' @($targetDir) 'Green'
    $nodeExe = Join-Path $targetDir 'node.exe'
    $info = Get-NodeInfo -Exe $nodeExe
    if ($null -eq $info) { throw (Get-Msg 'prepare.node.verifyFail' @($nodeExe)) }
    if ($info.major -lt 22) { throw (Get-Msg 'prepare.node.verifyFail' @('node ' + $info.version + ' < v22')) }
    $script:NodeInfo = $info
    $script:NodeSource = Get-Msg 'prepare.node.sourcePortable'
    Write-Msg 'prepare.node.verifyOk' @($info.version, $nodeExe) 'Green'
    Write-Msg 'prepare.node.done' @($info.version) 'Green'
    Set-Progress 'node' 'done' (Get-Msg 'prepare.node.done' @($info.version))
    Remove-Item -LiteralPath $zipPath -Force -ErrorAction SilentlyContinue
    Remove-Item -LiteralPath $extractDir -Recurse -Force -ErrorAction SilentlyContinue
    Set-NodePath
}

function Find-LocalDsh {
    $dshCmd = Join-Path $script:DshDir 'dsh.cmd'
    if (Test-Path -LiteralPath $dshCmd) { return $dshCmd }
    return ''
}

function Get-DshVersion {
    param([string]$DshCmd)
    $res = Invoke-CmdCapture -CmdPath $DshCmd -ArgString '--version'
    if ($res.code -ne 0) { return '' }
    $text = [string]$res.text
    $match = [regex]::Match($text, '(\d+\.\d+\.\d+(?:-[0-9A-Za-z][0-9A-Za-z.\-]*)?)')
    if ($match.Success) { return $match.Groups[1].Value }
    return $text.Trim()
}

function Test-DshHeadless {
    param([string]$DshCmd)
    $res = Invoke-CmdCapture -CmdPath $DshCmd -ArgString 'headless --help'
    if ($res.code -eq 0) {
        Write-Msg 'prepare.dsh.headlessOk' @() 'Green'
        return
    }
    $first = ([string]$res.text).Trim()
    if ($first.Length -gt 200) { $first = $first.Substring(0, 200) }
    Write-Msg 'prepare.dsh.headlessWarn' @($res.code, $first) 'Yellow'
}

function Invoke-NpmInstall {
    param([string]$NpmCmd, [string]$TargetDir, [string]$Package, [string]$RegistryUrl, [string]$LogPath, [switch]$IgnoreScripts)
    $argString = 'install --global --prefix "' + $TargetDir + '" ' + $Package + ' --no-audit --no-fund --loglevel=error'
    if ($IgnoreScripts) { $argString = $argString + ' --ignore-scripts' }
    if ($RegistryUrl -ne '') { $argString = $argString + ' --registry=' + $RegistryUrl }
    Write-Msg 'prepare.dsh.cmdline' @('cmd /d /s /c "' + $NpmCmd + '" ' + $argString) 'DarkGray'
    $psi = New-Object System.Diagnostics.ProcessStartInfo
    $psi.FileName = (Join-Path $env:SystemRoot 'System32\cmd.exe')
    $psi.Arguments = '/d /s /c ""' + $NpmCmd + '" ' + $argString + ' > "' + $LogPath + '" 2>&1"'
    $psi.UseShellExecute = $false
    $psi.CreateNoWindow = $true
    $psi.WorkingDirectory = $script:Root
    $proc = $null
    $position = 0
    try {
        $proc = [System.Diagnostics.Process]::Start($psi)
        while (-not $proc.HasExited) {
            Start-Sleep -Milliseconds 900
            $chunk = Write-NewText -Path $LogPath -Position $position
            $position = [long]$chunk.position
            foreach ($line in ([string]$chunk.text -split "`r?`n")) {
                if ($line.Trim() -ne '') { Write-Log ('  ' + $line) 'DarkGray' }
            }
        }
        $proc.WaitForExit()
        $chunk = Write-NewText -Path $LogPath -Position $position
        foreach ($line in ([string]$chunk.text -split "`r?`n")) {
            if ($line.Trim() -ne '') { Write-Log ('  ' + $line) 'DarkGray' }
        }
        return @{ code = $proc.ExitCode; log = $LogPath }
    } catch {
        return @{ code = -1; log = $LogPath }
    } finally {
        if ($proc) { try { $proc.Dispose() } catch { } }
    }
}

function Test-NpmPermFailure {
    param([string]$LogPath)
    if (-not (Test-Path -LiteralPath $LogPath)) { return $false }
    try {
        $text = Get-Content -LiteralPath $LogPath -Raw -Encoding UTF8
        if ($text -match 'EPERM') { return $true }
        if ($text -match 'errno: -4048') { return $true }
    } catch { }
    return $false
}

function Step-Dsh {
    Write-Msg 'prepare.dsh.check' @() 'Gray'
    $targetVersion = Get-Msg 'meta.dshVersion'
    $package = Get-Msg 'meta.dshPackage'
    $dshCmd = Find-LocalDsh
    if ($dshCmd -ne '') {
        $current = Get-DshVersion -DshCmd $dshCmd
        if ($current -eq $targetVersion -and -not $ForceDsh) {
            $script:DshVersion = $current
            Write-Msg 'prepare.dsh.found' @($current) 'Green'
            Set-Progress 'dsh' 'skipped' (Get-Msg 'prepare.dsh.found' @($current))
            $script:StepStatus = 'skipped'
            Test-DshHeadless -DshCmd $dshCmd
            return
        }
        if ($current -ne '') {
            if ($ForceDsh) { Write-Msg 'prepare.dsh.forcedReinstall' @($current) 'Yellow' }
            else { Write-Msg 'prepare.dsh.reinstall' @($current, $targetVersion) 'Yellow' }
        }
    }
    Set-NodePath
    $npmCmd = Find-NpmCmd
    if ($npmCmd -eq '') { throw (Get-Msg 'prepare.dsh.npmMissing') }
    $cacheDir = Join-Path $script:DataDir 'npm-cache'
    $tmpDir = Join-Path $script:DataDir 'tmp'
    foreach ($dir in @($cacheDir, $tmpDir)) {
        if (-not (Test-Path -LiteralPath $dir)) { [void](New-Item -ItemType Directory -Path $dir -Force -ErrorAction SilentlyContinue) }
    }
    $env:npm_config_cache = $cacheDir
    $env:npm_config_tmp = $tmpDir
    $env:npm_config_prefix = $script:DshDir
    $env:TEMP = $tmpDir
    $env:TMP = $tmpDir
    Write-Msg 'prepare.dsh.installing' @($package) 'Gray'
    Write-Msg 'prepare.dsh.targetDir' @($script:DshDir) 'DarkGray'
    Write-Msg 'prepare.dsh.firstTimeHint' @() 'DarkGray'
    $installLog = Join-Path $script:LogDir ('npm-' + $script:StartedAt.ToString('yyyyMMdd-HHmmss') + '.log')
    $primaryRegistry = $Registry
    $attempts = New-Object System.Collections.ArrayList
    [void]$attempts.Add(@{ registry = $primaryRegistry; ignore = $false })
    [void]$attempts.Add(@{ registry = 'https://registry.npmmirror.com'; ignore = $false })
    [void]$attempts.Add(@{ registry = 'https://registry.npmmirror.com'; ignore = $true })
    $timer = [System.Diagnostics.Stopwatch]::StartNew()
    $installed = $false
    $lastCode = -1
    $usedIgnoreScripts = $false
    for ($attempt = 0; $attempt -lt $attempts.Count; $attempt++) {
        $option = $attempts[$attempt]
        if ($attempt -gt 0) {
            if ($option.ignore) {
                Write-Msg 'prepare.dsh.ignoreScriptsHint' @() 'Yellow'
            } elseif ($option.registry -ne $primaryRegistry) {
                Write-Msg 'prepare.dsh.retryMirror' @($option.registry) 'Yellow'
            }
        }
        $res = Invoke-NpmInstall -NpmCmd $npmCmd -TargetDir $script:DshDir -Package $package -RegistryUrl $option.registry -LogPath $installLog -IgnoreScripts:$option.ignore
        $lastCode = $res.code
        if ($res.code -eq 0) {
            $installed = $true
            if ($option.ignore) { $usedIgnoreScripts = $true }
            break
        }
        Write-Msg 'prepare.dsh.installFail' @($res.code) 'Yellow'
        if ((-not $option.ignore) -and (Test-NpmPermFailure -LogPath $installLog)) {
            Write-Msg 'prepare.dsh.permBlocked' @() 'Yellow'
            $attempt = 1
        }
    }
    $timer.Stop()
    if (-not $installed) {
        Write-Msg 'prepare.dsh.copyHint' @() 'Yellow'
        throw ((Get-Msg 'prepare.dsh.installFail' @($lastCode)) + ' ' + (Get-Msg 'prepare.failed.log' @($installLog)))
    }
    if ($usedIgnoreScripts) { Write-Msg 'prepare.dsh.scriptsSkipped' @() 'Yellow' }
    Write-Msg 'prepare.dsh.elapsed' @([int]$timer.Elapsed.TotalSeconds) 'DarkGray'
    $dshCmd = Find-LocalDsh
    if ($dshCmd -eq '') { throw (Get-Msg 'prepare.dsh.missingBin' @((Join-Path $script:DshDir 'dsh.cmd'))) }
    Write-Msg 'prepare.dsh.verify' @() 'Gray'
    $version = Get-DshVersion -DshCmd $dshCmd
    if ($version -ne $targetVersion) {
        throw (Get-Msg 'prepare.dsh.versionMismatch' @($targetVersion, $version))
    }
    $script:DshVersion = $version
    Write-Msg 'prepare.dsh.versionOk' @($version) 'Green'
    Write-Msg 'prepare.dsh.done' @($version) 'Green'
    Set-Progress 'dsh' 'done' (Get-Msg 'prepare.dsh.done' @($version))
    Test-DshHeadless -DshCmd $dshCmd
}

function Show-Help {
    Write-Msg 'help.title' @() 'Cyan'
    foreach ($key in @('help.prepare1', 'help.prepare2', 'help.prepare3', 'help.prepare4', 'help.prepare5', 'help.machine')) {
        Write-Msg $key @() 'Gray'
    }
    Write-Log ''
    Write-Msg 'prepare.offlineHint' @() 'DarkGray'
}

# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------
try {
    Initialize-Messages
} catch {
    Write-Host ('[FATAL] ' + [string]$_.Exception.Message) -ForegroundColor Red
    exit 1
}

if ($Help) {
    Show-Help
    exit 0
}

try {
    $script:Root = Resolve-Root
    $script:DataDir = Join-Path $script:Root 'data'
    $script:LogDir = Join-Path $script:Root 'logs'
    $script:RuntimeDir = Join-Path $script:Root 'runtime'
    $script:DshDir = Join-Path $script:Root 'dsh'
    # DSH must never write into the user profile: use the product's private
    # DSH_HOME for every dsh invocation (version/headless self-check).
    $env:DSH_HOME = Join-Path $script:DataDir 'dsh-home'
    $env:CX_DSH_HOME = $env:DSH_HOME
    try {
        if (-not (Test-Path -LiteralPath $script:Root)) {
            [void](New-Item -ItemType Directory -Path $script:Root -Force -ErrorAction Stop)
        }
        if (-not (Test-Path -LiteralPath $script:DataDir)) {
            [void](New-Item -ItemType Directory -Path $script:DataDir -Force -ErrorAction Stop)
        }
        if (-not (Test-Path -LiteralPath $script:LogDir)) {
            [void](New-Item -ItemType Directory -Path $script:LogDir -Force -ErrorAction Stop)
        }
    } catch {
        throw (Get-Msg 'prepare.root.notWritable' @($script:Root))
    }
    Initialize-Log
    Write-Msg 'banner.top' @() 'DarkCyan'
    Write-Msg 'prepare.title' @() 'Cyan'
    Write-Msg 'start.root' @($script:Root) 'White'
    Write-Msg 'prepare.intro' @() 'Gray'
    Write-Msg 'prepare.offlineHint' @() 'DarkGray'
    Write-Msg 'banner.bottom' @() 'DarkCyan'

    Invoke-Step -StepId 'root' -TitleKey 'prepare.step.root' -Body { Step-Root }
    if (-not $OnlyDsh) {
        Invoke-Step -StepId 'node' -TitleKey 'prepare.step.node' -Body { Step-Node }
    }
    if ($NoDsh) {
        Write-Msg 'prepare.dsh.skipped' @() 'DarkGray'
    } else {
        Invoke-Step -StepId 'dsh' -TitleKey 'prepare.step.dsh' -Body { Step-Dsh }
    }

    $elapsed = ((Get-Date) - $script:StartedAt).TotalSeconds
    Set-Progress 'done' 'done' (Get-Msg 'prepare.done.title')
    Write-Log ''
    Write-Msg 'banner.top' @() 'DarkCyan'
    Write-Msg 'prepare.done.title' @() 'Green'
    Write-Msg 'prepare.done.root' @($script:Root) 'White'
    if ($script:NodeInfo) { Write-Msg 'prepare.done.node' @($script:NodeInfo.version, $script:NodeSource) 'White' }
    if ($script:DshVersion -ne '') { Write-Msg 'prepare.done.dsh' @($script:DshVersion) 'White' }
    Write-Msg 'prepare.done.log' @($script:LogFile) 'White'
    Write-Msg 'prepare.done.progress' @($script:ProgressFile) 'White'
    Write-Msg 'prepare.done.elapsed' @([int]$elapsed) 'White'
    Write-Msg 'prepare.done.hint' @() 'Cyan'
    Write-Msg 'prepare.done.portable' @() 'DarkGray'
    Write-Msg 'banner.top' @() 'DarkCyan'
    Write-MachineLine ('DONE|' + $script:DshVersion)
    exit 0
} catch {
    $reason = [string]$_.Exception.Message
    Write-Log ''
    Write-Msg 'banner.top' @() 'Red'
    Write-Msg 'prepare.failed.title' @() 'Red'
    Write-Msg 'prepare.failed.reason' @($reason) 'Red'
    if ($script:LogFile -ne '') { Write-Msg 'prepare.failed.log' @($script:LogFile) 'Yellow' }
    Write-Msg 'prepare.failed.retry' @() 'Yellow'
    Write-Msg 'banner.top' @() 'Red'
    if ($script:ProgressFile -ne '') { Set-Progress ($script:CurrentStepId) 'failed' $reason }
    Write-MachineLine ('FAIL|' + $reason)
    exit 1
}
