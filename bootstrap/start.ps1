# Chaoxing Homework Assistant v1.4.0
# Copyright (c) 2026 sevenplayer (Lsy). All rights reserved.
# SPDX-License-Identifier: MIT
# Powered by DeepSeek (AI-assisted development)

<#
  ChaoxingHomework - launcher for the portable (green / no-install) edition.
  ------------------------------------------------------------------------
  Resolves the program directory, finds a usable Node.js and DSH CLI (all
  local to the program directory first, then the system), exports
  CX_APP_ROOT / CX_NODE / CX_DSH / CX_DSH_HOME, writes <root>\data\env.json,
  starts "node app\server.mjs" detached and waits for the app to publish
  <root>\data\server.json ({port,url,pid,startedAt}), then opens the browser.
  Never modifies system PATH, registry or the user's global npm directory.
  ------------------------------------------------------------------------
  This file is intentionally pure ASCII (Windows PowerShell 5.1 reads .ps1
  as ANSI). Chinese text lives in messages.json (UTF-8).
  ------------------------------------------------------------------------
  Machine-readable output (when stdout is redirected or -Machine is given):
      STEP|1|1|launch|<running|done|failed>
      DONE|<dshVersion>
      FAIL|<reason>
#>
[CmdletBinding()]
param(
    [string]$AppRoot = '',
    [string]$Root = '',
    [int]$Port = 8765,
    [switch]$NoBrowser,
    [switch]$Machine,
    [switch]$Help
)

$ErrorActionPreference = 'Continue'
$RootRequested = $Root
$script:Utf8 = New-Object System.Text.UTF8Encoding($false)
$script:Messages = $null
$script:Root = ''
$script:DataDir = ''
$script:LogDir = ''
$script:AppDir = ''
$script:RuntimeDir = ''
$script:DshDir = ''
$script:LogFile = ''
$script:StartedAt = (Get-Date)
$script:NodeInfo = $null
$script:NodeSource = ''
$script:DshInfo = $null
$script:MachineMode = $false
$script:DefaultPort = $Port

if (-not [Console]::IsOutputRedirected) {
    $script:MachineMode = [bool]$Machine
} else {
    $script:MachineMode = $true
}
if ($script:MachineMode) {
    try { [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false) } catch { }
}

# ---------------------------------------------------------------------------
# Messages / logging
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
    throw 'messages.json not found next to start.ps1'
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

# ---------------------------------------------------------------------------
# Utilities
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
    $script:LogFile = Join-Path $script:LogDir ('start-' + $stamp + '.log')
    $header = New-Object System.Collections.ArrayList
    [void]$header.Add('==== ChaoxingHomework start log ====')
    [void]$header.Add('time: ' + (Get-Date).ToString('yyyy-MM-dd HH:mm:ss'))
    [void]$header.Add('root: ' + $script:Root)
    [void]$header.Add('ps  : ' + $PSVersionTable.PSVersion.ToString())
    [void]$header.Add('os  : ' + [Environment]::OSVersion.VersionString)
    [void]$header.Add('arch: ' + $env:PROCESSOR_ARCHITECTURE)
    [void]$header.Add('args: ' + [string]$MyInvocation.Line)
    [void]$header.Add('====================================')
    foreach ($line in $header) {
        try { [System.IO.File]::AppendAllText($script:LogFile, $line + "`r`n", $script:Utf8) } catch { }
    }
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
    param([string]$CmdPath, [string]$ArgString = '')
    $tmpDir = Join-Path $script:DataDir 'tmp'
    if (-not (Test-Path -LiteralPath $tmpDir)) { [void](New-Item -ItemType Directory -Path $tmpDir -Force -ErrorAction SilentlyContinue) }
    $outFile = Join-Path $tmpDir ('cmd-' + [Guid]::NewGuid().ToString('N') + '.log')
    $result = @{ code = -1; text = '' }
    try {
        $psi = New-Object System.Diagnostics.ProcessStartInfo
        $psi.FileName = (Join-Path $env:SystemRoot 'System32\cmd.exe')
        $psi.Arguments = '/d /s /c ""' + $CmdPath + '" ' + $ArgString + ' > "' + $outFile + '" 2>&1"'
        $psi.UseShellExecute = $false
        $psi.CreateNoWindow = $true
        $psi.WorkingDirectory = $script:Root
        $proc = [System.Diagnostics.Process]::Start($psi)
        $proc.WaitForExit()
        $result.code = $proc.ExitCode
        if (Test-Path -LiteralPath $outFile) {
            try { $result.text = [string](Get-Content -LiteralPath $outFile -Raw -Encoding UTF8) } catch { }
        }
    } catch {
        $result.code = -1
        $result.text = [string]$_.Exception.Message
    } finally {
        Remove-Item -LiteralPath $outFile -Force -ErrorAction SilentlyContinue
    }
    return $result
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

function Resolve-Node {
    $portableExe = Join-Path (Join-Path $script:RuntimeDir 'node') 'node.exe'
    if (Test-Path -LiteralPath $portableExe) {
        $info = Get-NodeInfo -Exe $portableExe
        if ($info -and $info.major -ge 22) {
            $script:NodeInfo = $info
            $script:NodeSource = 'portable'
            Write-Msg 'start.nodePortable' @($info.version) 'Green'
            return $script:NodeInfo
        }
        if ($info) { Write-Msg 'start.nodeOld' @($info.version) 'Yellow' }
    }
    $system = Find-SystemNode
    if ($system -and $system.major -ge 22) {
        $script:NodeInfo = $system
        $script:NodeSource = 'system'
        Write-Msg 'start.nodeSystem' @($system.version) 'Green'
        return $script:NodeInfo
    }
    if ($system) { Write-Msg 'start.nodeOld' @($system.version) 'Yellow' }
    return $null
}

function Get-DshCandidates {
    # Collect every plausible DSH entry (portable / npm global / pnpm / PATH / npm prefix).
    $raw = New-Object System.Collections.ArrayList
    if ($env:CX_DSH) { [void]$raw.Add($env:CX_DSH) }
    [void]$raw.Add((Join-Path $script:DshDir 'dsh.cmd'))
    [void]$raw.Add((Join-Path $script:DshDir 'node_modules\.bin\dsh.cmd'))
    [void]$raw.Add((Join-Path $script:DshDir 'node_modules\@deepseek-ai\dsh\lib\bin.js'))
    foreach ($name in @('dsh.cmd', 'dsh.exe', 'dsh')) {
        $cmd = Get-Command $name -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
        if ($cmd) { [void]$raw.Add($cmd.Source) }
    }
    if ($env:APPDATA) {
        [void]$raw.Add((Join-Path $env:APPDATA 'npm\dsh.cmd'))
        [void]$raw.Add((Join-Path $env:APPDATA 'pnpm\dsh.cmd'))
    }
    if ($env:LOCALAPPDATA) {
        [void]$raw.Add((Join-Path $env:LOCALAPPDATA 'npm\dsh.cmd'))
        [void]$raw.Add((Join-Path $env:LOCALAPPDATA 'pnpm\dsh.cmd'))
        [void]$raw.Add((Join-Path $env:LOCALAPPDATA 'Programs\nodejs\dsh.cmd'))
    }
    if ($env:ProgramFiles) { [void]$raw.Add((Join-Path $env:ProgramFiles 'nodejs\dsh.cmd')) }
    if (${env:ProgramFiles(x86)}) { [void]$raw.Add((Join-Path ${env:ProgramFiles(x86)} 'nodejs\dsh.cmd')) }
    try {
        $whereOut = & where.exe dsh 2>$null
        foreach ($line in @($whereOut)) { if ($line) { [void]$raw.Add([string]$line) } }
    } catch { }

    $list = New-Object System.Collections.ArrayList
    $seen = @{}
    foreach ($p in @($raw)) {
        if (-not $p) { continue }
        $full = ''
        try { $full = [System.IO.Path]::GetFullPath([string]$p) } catch { continue }
        if (-not (Test-Path -LiteralPath $full)) { continue }
        $key = $full.ToLowerInvariant()
        if ($seen.ContainsKey($key)) { continue }
        $seen[$key] = $true
        [void]$list.Add($full)
    }
    return ,$list
}

function Get-DshVersion {
    param([string]$DshCmd)
    if (-not $DshCmd) { return '' }
    $res = $null
    if ($DshCmd -match '\.js$') {
        $nodeExe = 'node'
        if ($script:NodeInfo -and $script:NodeInfo.path) { $nodeExe = $script:NodeInfo.path }
        $res = Invoke-ExeText -Exe $nodeExe -ExeArgs @($DshCmd, '--version')
    } else {
        $res = Invoke-CmdCapture -CmdPath $DshCmd -ArgString '--version'
    }
    if (-not $res -or $res.code -ne 0) { return '' }
    $text = [string]$res.text
    $match = [regex]::Match($text, '(\d+\.\d+\.\d+(?:-[0-9A-Za-z][0-9A-Za-z.\-]*)?)')
    if ($match.Success) { return $match.Groups[1].Value }
    return $text.Trim()
}

function Invoke-DshRepair {
    # Called when no usable DSH is found: run prepare.ps1 with -OnlyDsh so the portable
    # Node.js in the program folder can install DSH without touching the system.
    $prepare = Join-Path $PSScriptRoot 'prepare.ps1'
    if (-not (Test-Path -LiteralPath $prepare)) { return $false }
    Write-Msg 'start.dshRepair' @() 'Yellow'
    $ps = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
    if (-not (Test-Path -LiteralPath $ps)) { $ps = 'powershell.exe' }
    $code = -1
    try {
        & $ps -NoProfile -ExecutionPolicy Bypass -File $prepare -OnlyDsh -Root $script:Root -AppRoot $script:Root
        $code = $LASTEXITCODE
    } catch {
        Write-Log ('DSH repair exception: ' + $_.Exception.Message)
        return $false
    }
    Write-Log ('DSH repair exit=' + $code)
    if ($code -eq 0) { return $true }
    Write-Msg 'start.dshRepairFail' @([string]$code) 'Yellow'
    return $false
}

function Resolve-Dsh {
    for ($attempt = 0; $attempt -lt 2; $attempt++) {
        $candidates = Get-DshCandidates
        foreach ($candidate in @($candidates)) {
            $version = Get-DshVersion -DshCmd $candidate
            if ($version -ne '') {
                $source = 'system'
                $localDsh = Join-Path $script:DshDir 'dsh.cmd'
                if ($candidate.TrimEnd('\') -ieq $localDsh.TrimEnd('\')) { $source = 'portable' }
                $script:DshInfo = [PSCustomObject]@{ path = $candidate; version = $version; source = $source }
                if ($source -eq 'portable') {
                    Write-Msg 'start.dshLocal' @($version, $candidate) 'Green'
                } else {
                    Write-Msg 'start.dshSystem' @($version, $candidate) 'Green'
                }
                return $script:DshInfo
            }
            Write-Log ('DSH candidate failed: ' + $candidate)
        }
        Write-Log ('DSH candidates: ' + (@($candidates) -join ' | '))
        if ($attempt -eq 0) {
            if (-not (Invoke-DshRepair)) { break }
        }
    }
    return $null
}

function Test-PortOpen {
    param([int]$PortNumber)
    $client = $null
    try {
        $client = New-Object System.Net.Sockets.TcpClient
        $iar = $client.BeginConnect('127.0.0.1', $PortNumber, $null, $null)
        if (-not $iar.AsyncWaitHandle.WaitOne(300, $false)) { return $false }
        $client.EndConnect($iar)
        return $true
    } catch {
        return $false
    } finally {
        if ($client) { try { $client.Close() } catch { } }
    }
}

function Test-PidAlive {
    param([int]$ProcessId)
    if ($ProcessId -le 0) { return $false }
    $proc = Get-Process -Id $ProcessId -ErrorAction SilentlyContinue
    if ($null -eq $proc) { return $false }
    return $true
}

function Read-ServerJson {
    $path = Join-Path $script:DataDir 'server.json'
    if (-not (Test-Path -LiteralPath $path)) { return $null }
    try {
        $raw = Get-Content -LiteralPath $path -Raw -Encoding UTF8
        if (-not $raw) { return $null }
        $obj = $raw | ConvertFrom-Json
        if ($null -eq $obj) { return $null }
        $portValue = 0
        if ($obj.port) { $portValue = [int]$obj.port }
        if ($portValue -le 0) { return $null }
        $urlValue = [string]$obj.url
        if ($urlValue -eq '') { $urlValue = 'http://127.0.0.1:' + $portValue }
        $pidValue = 0
        if ($obj.pid) { $pidValue = [int]$obj.pid }
        return @{ port = $portValue; url = $urlValue; pid = $pidValue; raw = $obj }
    } catch {
        return $null
    }
}

function Write-EnvJson {
    param([string]$Url = '')
    $obj = [PSCustomObject]@{
        generatedAt = (Get-Date).ToString('yyyy-MM-ddTHH:mm:sszzz')
        root        = $script:Root
        edition     = 'portable'
        port        = $script:DefaultPort
        url         = $Url
        node        = [PSCustomObject]@{
            found   = ($null -ne $script:NodeInfo)
            version = $(if ($script:NodeInfo) { $script:NodeInfo.version } else { '' })
            path    = $(if ($script:NodeInfo) { $script:NodeInfo.path } else { '' })
            source  = $script:NodeSource
        }
        dsh         = [PSCustomObject]@{
            found   = ($null -ne $script:DshInfo)
            version = $(if ($script:DshInfo) { $script:DshInfo.version } else { '' })
            path    = $(if ($script:DshInfo) { $script:DshInfo.path } else { '' })
            source  = $(if ($script:DshInfo) { $script:DshInfo.source } else { '' })
        }
        app         = [PSCustomObject]@{
            dir          = $script:AppDir
            serverExists = (Test-Path -LiteralPath (Join-Path $script:AppDir 'server.mjs'))
        }
        env         = [PSCustomObject]@{
            CX_APP_ROOT = $script:Root
            CX_NODE     = $(if ($script:NodeInfo) { $script:NodeInfo.path } else { '' })
            CX_DSH      = $(if ($script:DshInfo) { $script:DshInfo.path } else { '' })
            CX_DSH_HOME = (Join-Path $script:DataDir 'dsh-home')
        }
    }
    $json = $obj | ConvertTo-Json -Depth 6
    $envPath = Join-Path $script:DataDir 'env.json'
    try {
        [System.IO.File]::WriteAllText($envPath, $json, $script:Utf8)
        Write-Msg 'start.envFile' @($envPath) 'DarkGray'
    } catch { }
    return $envPath
}

function Open-Browser {
    param([string]$Url)
    if ($NoBrowser) {
        Write-Msg 'start.noBrowser' @() 'Gray'
        return
    }
    Write-Msg 'start.browser' @($Url) 'Gray'
    try { Start-Process $Url | Out-Null } catch { }
}

function Show-Help {
    Write-Msg 'help.title' @() 'Cyan'
    foreach ($key in @('help.start1', 'help.start2', 'help.start3', 'help.machine')) {
        Write-Msg $key @() 'Gray'
    }
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
    Write-MachineLine 'STEP|1|1|launch|running'
    $script:Root = Resolve-Root
    $script:DataDir = Join-Path $script:Root 'data'
    $script:LogDir = Join-Path $script:Root 'logs'
    $script:AppDir = Join-Path $script:Root 'app'
    $script:RuntimeDir = Join-Path $script:Root 'runtime'
    $script:DshDir = Join-Path $script:Root 'dsh'
    if (-not (Test-Path -LiteralPath $script:DataDir)) {
        [void](New-Item -ItemType Directory -Path $script:DataDir -Force -ErrorAction SilentlyContinue)
    }
    if (-not (Test-Path -LiteralPath $script:LogDir)) {
        [void](New-Item -ItemType Directory -Path $script:LogDir -Force -ErrorAction SilentlyContinue)
    }
    Initialize-Log
    Write-Msg 'banner.top' @() 'DarkCyan'
    Write-Msg 'start.title' @() 'Cyan'
    Write-Msg 'start.root' @($script:Root) 'White'
    Write-Msg 'banner.bottom' @() 'DarkCyan'

    # Already running?
    $existing = Read-ServerJson
    if ($null -ne $existing) {
        $alive = $true
        if ($existing.pid -gt 0) { $alive = Test-PidAlive -ProcessId $existing.pid }
        if ($alive -and (Test-PortOpen -PortNumber $existing.port)) {
            Write-Msg 'start.already' @($existing.port) 'Green'
            Write-Msg 'start.ready' @($existing.url) 'Green'
            Open-Browser -Url $existing.url
            $knownVersion = ''
            $envFile = Join-Path $script:DataDir 'env.json'
            if (Test-Path -LiteralPath $envFile) {
                try {
                    $rawEnv = Get-Content -LiteralPath $envFile -Raw -Encoding UTF8
                    $envObj = $rawEnv | ConvertFrom-Json
                    if ($envObj.dsh -and $envObj.dsh.version) { $knownVersion = [string]$envObj.dsh.version }
                } catch { }
            }
            Write-MachineLine ('DONE|' + $knownVersion)
            exit 0
        }
        Remove-Item -LiteralPath (Join-Path $script:DataDir 'server.json') -Force -ErrorAction SilentlyContinue
    }

    $node = Resolve-Node
    if ($null -eq $node) { throw (Get-Msg 'start.nodeMissing') }
    # Important: put Node on PATH BEFORE probing DSH. npm's dsh.cmd shim calls "node"
    # from PATH (there is no node.exe next to it), so on a machine that only has the
    # portable Node (no system Node), DSH would look missing even after prepare.
    $nodeDir = Split-Path -Path $node.path -Parent
    if ($nodeDir) {
        $nodeAlreadyOnPath = $false
        foreach ($part in ($env:PATH -split ';')) {
            if ($part -and $part.TrimEnd('\') -ieq $nodeDir.TrimEnd('\')) { $nodeAlreadyOnPath = $true }
        }
        if (-not $nodeAlreadyOnPath) { $env:PATH = $nodeDir + ';' + $env:PATH }
    }
    $dsh = Resolve-Dsh
    if ($null -eq $dsh) { throw (Get-Msg 'start.dshMissing') }
    $serverPath = Join-Path $script:AppDir 'server.mjs'
    if (-not (Test-Path -LiteralPath $serverPath)) {
        throw (Get-Msg 'start.appMissing' @($serverPath))
    }

    # Export the runtime contract for the app (process environment).
    $nodeDir = Split-Path -Path $node.path -Parent
    $dshHome = Join-Path $script:DataDir 'dsh-home'
    if (-not (Test-Path -LiteralPath $dshHome)) {
        [void](New-Item -ItemType Directory -Path $dshHome -Force -ErrorAction SilentlyContinue)
    }
    $env:CX_APP_ROOT = $script:Root
    $env:CX_NODE = $node.path
    $env:CX_DSH = $dsh.path
    $env:CX_DSH_HOME = $dshHome
    $env:DSH_HOME = $dshHome
    $env:PATH = $nodeDir + ';' + (Split-Path -Path $dsh.path -Parent) + ';' + $env:PATH
    [void](Write-EnvJson -Url ('http://127.0.0.1:' + $script:DefaultPort))

    $stamp = $script:StartedAt.ToString('yyyyMMdd-HHmmss')
    $outLog = Join-Path $script:LogDir ('app-out-' + $stamp + '.log')
    $errLog = Join-Path $script:LogDir ('app-err-' + $stamp + '.log')
    Write-Msg 'start.starting' @($serverPath) 'Gray'
    $proc = $null
    try {
        $proc = Start-Process -FilePath $node.path -ArgumentList 'server.mjs' -WorkingDirectory $script:AppDir -WindowStyle Hidden -RedirectStandardOutput $outLog -RedirectStandardError $errLog -PassThru -ErrorAction Stop
    } catch {
        throw (Get-Msg 'start.fail' @([string]$_.Exception.Message))
    }
    try {
        [System.IO.File]::WriteAllText((Join-Path $script:DataDir 'app.pid'), [string]$proc.Id, $script:Utf8)
    } catch { }

    Write-Msg 'start.wait' @() 'Gray'
    $serverInfo = $null
    $exited = $false
    $exitCode = 0
    for ($i = 0; $i -lt 40; $i++) {
        Start-Sleep -Milliseconds 500
        $serverInfo = Read-ServerJson
        if ($null -ne $serverInfo) { break }
        if ($proc.HasExited) {
            $exited = $true
            $exitCode = $proc.ExitCode
            break
        }
    }
    if ($null -ne $serverInfo) {
        $url = $serverInfo.url
        [void](Write-EnvJson -Url $url)
        Write-Msg 'start.started' @($serverInfo.pid, $url) 'Green'
        Write-Msg 'start.ready' @($url) 'Green'
        Write-Msg 'start.logHint' @($script:LogDir) 'DarkGray'
        Open-Browser -Url $url
        Write-MachineLine ('DONE|' + $dsh.version)
        exit 0
    }
    if ($exited) {
        throw (Get-Msg 'start.exited' @($exitCode, $errLog))
    }
    throw (Get-Msg 'start.timeout' @($proc.Id, $script:LogDir))
} catch {
    $reason = [string]$_.Exception.Message
    Write-Log ''
    Write-Msg 'banner.top' @() 'Red'
    Write-Msg 'failed.title' @() 'Red'
    Write-Msg 'failed.reason' @($reason) 'Red'
    if ($script:LogFile -ne '') { Write-Msg 'failed.log' @($script:LogFile) 'Yellow' }
    Write-Msg 'banner.bottom' @() 'Red'
    Write-MachineLine 'STEP|1|1|launch|failed'
    Write-MachineLine ('FAIL|' + $reason)
    exit 1
}
