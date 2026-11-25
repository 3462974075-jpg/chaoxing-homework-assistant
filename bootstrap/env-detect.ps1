# Chaoxing Homework Assistant v1.5.0
# Copyright (c) 2026 sevenplayer (Lsy). All rights reserved.
# SPDX-License-Identifier: MIT
# Powered by DeepSeek (AI-assisted development)

<#
  ChaoxingHomework - environment detection for the portable (green) edition.
  ------------------------------------------------------------------------
  Prints a JSON document with the detected Node.js / npm / DSH / Python /
  Git / MSVC versions and paths. The app can call this script directly and
  parse stdout, or let start.ps1 write <root>\data\env.json.
  ------------------------------------------------------------------------
  This file is intentionally pure ASCII (Windows PowerShell 5.1 reads .ps1
  as ANSI). Chinese text lives in messages.json (UTF-8).
  ------------------------------------------------------------------------
  Usage:
      powershell -NoProfile -ExecutionPolicy Bypass -File env-detect.ps1
          [ -Root <program dir> ] [ -Json | -Human ] [ -Save ] [ -Deep ]
  Default output is compact JSON on stdout.
#>
[CmdletBinding()]
param(
    [string]$AppRoot = '',
    [string]$Root = '',
    [switch]$Human,
    [switch]$Save,
    [switch]$Deep,
    [switch]$Help
)

$ErrorActionPreference = 'Continue'
$RootRequested = $Root
$script:Utf8 = New-Object System.Text.UTF8Encoding($false)
$script:Messages = $null
$script:Root = ''

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
            try {
                $raw = Get-Content -LiteralPath $candidate -Raw -Encoding UTF8
                $script:Messages = $raw | ConvertFrom-Json
            } catch { }
            return
        }
    }
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

function Invoke-ExeText {
    param([string]$Exe, [string[]]$ExeArgs = @())
    $text = ''
    $code = -1
    try {
        $out = & $Exe @ExeArgs 2>&1 | ForEach-Object { [string]$_ }
        $text = ($out -join "`n")
        $code = $LASTEXITCODE
    } catch {
        $text = ''
        $code = -1
    }
    return @{ code = $code; text = $text }
}

function Invoke-CmdCapture {
    param([string]$CmdPath, [string]$ArgString = '')
    $tmp = [System.IO.Path]::GetTempPath()
    $outFile = Join-Path $tmp ('cx-env-' + [Guid]::NewGuid().ToString('N') + '.log')
    $result = @{ code = -1; text = '' }
    try {
        $psi = New-Object System.Diagnostics.ProcessStartInfo
        $psi.FileName = (Join-Path $env:SystemRoot 'System32\cmd.exe')
        $psi.Arguments = '/d /s /c ""' + $CmdPath + '" ' + $ArgString + ' > "' + $outFile + '" 2>&1"'
        $psi.UseShellExecute = $false
        $psi.CreateNoWindow = $true
        $psi.WorkingDirectory = $tmp
        $proc = [System.Diagnostics.Process]::Start($psi)
        $proc.WaitForExit()
        $result.code = $proc.ExitCode
        if (Test-Path -LiteralPath $outFile) {
            $result.text = [string](Get-Content -LiteralPath $outFile -Raw -Encoding UTF8)
        }
    } catch {
        $result.code = -1
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
    $text = ([string]$res.text).Trim()
    if ($text -match 'v?(\d+)\.(\d+)\.(\d+)') {
        $major = [int]$Matches[1]
        $minor = [int]$Matches[2]
        $patch = [int]$Matches[3]
        return [PSCustomObject]@{
            path         = $Exe
            version      = ('v' + $major + '.' + $minor + '.' + $patch)
            major        = $major
            minor        = $minor
            patch        = $patch
            meetsMinimum = ($major -ge 22)
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
    $portableExe = Join-Path (Join-Path $script:Root 'runtime\node') 'node.exe'
    if (Test-Path -LiteralPath $portableExe) {
        $info = Get-NodeInfo -Exe $portableExe
        if ($info -and $info.meetsMinimum) {
            return [PSCustomObject]@{ path = $info.path; version = $info.version; major = $info.major; meetsMinimum = $info.meetsMinimum; source = 'portable' }
        }
    }
    $system = Find-SystemNode
    if ($system) {
        return [PSCustomObject]@{ path = $system.path; version = $system.version; major = $system.major; meetsMinimum = $system.meetsMinimum; source = 'system' }
    }
    return $null
}

function Find-NpmCmd {
    $candidates = New-Object System.Collections.ArrayList
    if ($script:NodeValue -and $script:NodeValue.path) {
        [void]$candidates.Add((Join-Path (Split-Path -Path $script:NodeValue.path -Parent) 'npm.cmd'))
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

function Resolve-Dsh {
    $candidates = New-Object System.Collections.ArrayList
    $envDsh = [Environment]::GetEnvironmentVariable('CX_DSH')
    if ($envDsh) { [void]$candidates.Add($envDsh) }
    [void]$candidates.Add((Join-Path $script:Root 'dsh\dsh.cmd'))
    $cmd = Get-Command 'dsh.cmd' -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($cmd) { [void]$candidates.Add($cmd.Source) }
    if ($env:APPDATA) { [void]$candidates.Add((Join-Path $env:APPDATA 'npm\dsh.cmd')) }
    if ($env:LOCALAPPDATA) { [void]$candidates.Add((Join-Path $env:LOCALAPPDATA 'npm\dsh.cmd')) }
    if ($env:ProgramFiles) { [void]$candidates.Add((Join-Path $env:ProgramFiles 'nodejs\dsh.cmd')) }
    $localDsh = Join-Path $script:Root 'dsh\dsh.cmd'
    foreach ($candidate in $candidates) {
        if (-not $candidate) { continue }
        if (-not (Test-Path -LiteralPath $candidate)) { continue }
        $res = Invoke-CmdCapture -CmdPath $candidate -ArgString '--version'
        $text = ([string]$res.text).Trim()
        if ($text -eq '') { continue }
        $versionMatch = [regex]::Match($text, '(\d+\.\d+\.\d+(?:-[0-9A-Za-z][0-9A-Za-z.\-]*)?)')
        $version = $text
        if ($versionMatch.Success) { $version = $versionMatch.Groups[1].Value }
        $source = 'system'
        if ($candidate.TrimEnd('\') -ieq $localDsh.TrimEnd('\')) { $source = 'portable' }
        $headless = 'unknown'
        if ($Deep) {
            $hres = Invoke-CmdCapture -CmdPath $candidate -ArgString 'headless --help'
            $headless = ($hres.code -eq 0)
        }
        return [PSCustomObject]@{
            found      = $true
            path       = $candidate
            version    = $version
            source     = $source
            headlessOk = $headless
        }
    }
    return $null
}

function Find-ToolExe {
    param([string[]]$Names)
    foreach ($name in $Names) {
        $cmd = Get-Command $name -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
        if ($cmd) { return $cmd.Source }
    }
    return ''
}

function Get-FirstLine {
    param([string]$Text)
    if (-not $Text) { return '' }
    foreach ($line in ($Text -split "`r?`n")) {
        if ($line.Trim() -ne '') { return $line.Trim() }
    }
    return ''
}

function Get-ToolVersion {
    param([string]$Name)
    $exe = Find-ToolExe -Names @($Name)
    if ($exe -eq '') { return $null }
    $res = Invoke-ExeText -Exe $exe -ExeArgs @('--version')
    $version = Get-FirstLine ($res.text)
    if ($version -eq '') { return $null }
    return [PSCustomObject]@{ found = $true; path = $exe; version = $version }
}

function Get-PythonInfo {
    $exe = Find-ToolExe -Names @('python.exe', 'python', 'py.exe', 'py')
    if ($exe -eq '') { return $null }
    $res = Invoke-ExeText -Exe $exe -ExeArgs @('--version')
    $version = Get-FirstLine ($res.text)
    if ($version -eq '') { return $null }
    return [PSCustomObject]@{ found = $true; path = $exe; version = $version }
}

function Get-GitInfo {
    $exe = Find-ToolExe -Names @('git.exe', 'git')
    if ($exe -eq '') { return $null }
    $res = Invoke-ExeText -Exe $exe -ExeArgs @('--version')
    $version = Get-FirstLine ($res.text)
    if ($version -eq '') { return $null }
    return [PSCustomObject]@{ found = $true; path = $exe; version = $version }
}

function Get-MsvcInfo {
    $cl = Find-ToolExe -Names @('cl.exe', 'cl')
    if ($cl -ne '') { return [PSCustomObject]@{ found = $true; path = $cl; version = 'cl.exe' } }
    $vswhere = ''
    if (${env:ProgramFiles(x86)}) {
        $candidate = Join-Path ${env:ProgramFiles(x86)} 'Microsoft Visual Studio\Installer\vswhere.exe'
        if (Test-Path -LiteralPath $candidate) { $vswhere = $candidate }
    }
    if ($vswhere -ne '') {
        $res = Invoke-ExeText -Exe $vswhere -ExeArgs @('-latest', '-products', '*', '-requires', 'Microsoft.VisualStudio.Component.VC.Tools.x86.x64', '-property', 'installationPath')
        $path = Get-FirstLine ($res.text)
        if ($path -ne '') { return [PSCustomObject]@{ found = $true; path = $path; version = 'MSVC BuildTools' } }
    }
    return $null
}

function Test-IsAdmin {
    try {
        $identity = [System.Security.Principal.WindowsIdentity]::GetCurrent()
        $principal = New-Object System.Security.Principal.WindowsPrincipal($identity)
        return $principal.IsInRole([System.Security.Principal.WindowsBuiltInRole]::Administrator)
    } catch {
        return $false
    }
}

function Get-Detection {
    $node = Resolve-Node
    $script:NodeValue = $node
    $npmCmd = ''
    $npmVersion = ''
    if ($null -ne $node) {
        # Make the chosen node available to cmd shims during detection.
        $nodeDir = Split-Path -Path $node.path -Parent
        $env:PATH = $nodeDir + ';' + $env:PATH
        $npmCmd = Find-NpmCmd
        if ($npmCmd -ne '') {
            $res = Invoke-CmdCapture -CmdPath $npmCmd -ArgString '--version'
            $npmVersion = Get-FirstLine ([string]$res.text)
        }
    }
    $dsh = Resolve-Dsh
    $python = Get-PythonInfo
    $git = Get-GitInfo
    $msvc = Get-MsvcInfo
    $appDir = Join-Path $script:Root 'app'
    $serverPath = Join-Path $appDir 'server.mjs'
    $port = 8765
    if ($script:Messages -and $script:Messages.meta -and $script:Messages.meta.port) { $port = [int]$script:Messages.meta.port }
    $ready = (($null -ne $node) -and $node.meetsMinimum -and ($null -ne $dsh))
    return [PSCustomObject]@{
        generatedAt = (Get-Date).ToString('yyyy-MM-ddTHH:mm:sszzz')
        root        = $script:Root
        os          = [PSCustomObject]@{
            version = [Environment]::OSVersion.VersionString
            arch    = $env:PROCESSOR_ARCHITECTURE
            is64    = [Environment]::Is64BitOperatingSystem
        }
        admin       = (Test-IsAdmin)
        node        = [PSCustomObject]@{
            found        = ($null -ne $node)
            version      = $(if ($node) { $node.version } else { '' })
            major        = $(if ($node) { $node.major } else { 0 })
            path         = $(if ($node) { $node.path } else { '' })
            source       = $(if ($node) { $node.source } else { '' })
            meetsMinimum = $(if ($node) { $node.meetsMinimum } else { $false })
        }
        npm         = [PSCustomObject]@{
            found   = ($npmCmd -ne '')
            version = $npmVersion
            path    = $npmCmd
        }
        dsh         = [PSCustomObject]@{
            found      = ($null -ne $dsh)
            version    = $(if ($dsh) { $dsh.version } else { '' })
            path       = $(if ($dsh) { $dsh.path } else { '' })
            source     = $(if ($dsh) { $dsh.source } else { '' })
            headlessOk = $(if ($dsh) { $dsh.headlessOk } else { 'unknown' })
        }
        python      = [PSCustomObject]@{
            found   = ($null -ne $python)
            version = $(if ($python) { $python.version } else { '' })
            path    = $(if ($python) { $python.path } else { '' })
        }
        git         = [PSCustomObject]@{
            found   = ($null -ne $git)
            version = $(if ($git) { $git.version } else { '' })
            path    = $(if ($git) { $git.path } else { '' })
        }
        msvc        = [PSCustomObject]@{
            found   = ($null -ne $msvc)
            version = $(if ($msvc) { $msvc.version } else { '' })
            path    = $(if ($msvc) { $msvc.path } else { '' })
        }
        app         = [PSCustomObject]@{
            dir          = $appDir
            serverExists = (Test-Path -LiteralPath $serverPath)
            port         = $port
        }
        ready       = $ready
    }
}

function Show-Human {
    param($Info)
    Write-Host (Get-Msg 'detect.title') -ForegroundColor Cyan
    Write-Host (Get-Msg 'detect.root' @($script:Root))
    Write-Host (Get-Msg 'detect.os' @($Info.os.version, $Info.os.arch))
    $adminText = Get-Msg 'detect.no'
    if ($Info.admin) { $adminText = Get-Msg 'detect.yes' }
    Write-Host (Get-Msg 'detect.admin' @($adminText))
    if ($Info.node.found) {
        Write-Host (Get-Msg 'detect.node' @($Info.node.version, $Info.node.path))
    } else {
        Write-Host (Get-Msg 'detect.nodeNone') -ForegroundColor Yellow
    }
    if ($Info.npm.found) {
        Write-Host (Get-Msg 'detect.npm' @(($Info.npm.version + ' ' + $Info.npm.path).Trim()))
    } else {
        Write-Host (Get-Msg 'detect.npmNone') -ForegroundColor Yellow
    }
    if ($Info.dsh.found) {
        Write-Host (Get-Msg 'detect.dsh' @($Info.dsh.version, $Info.dsh.path))
    } else {
        Write-Host (Get-Msg 'detect.dshNone') -ForegroundColor Yellow
    }
    if ($Info.python.found) { Write-Host (Get-Msg 'detect.python' @($Info.python.version)) }
    if ($Info.git.found) { Write-Host (Get-Msg 'detect.git' @($Info.git.version)) }
    if ($Info.msvc.found) { Write-Host (Get-Msg 'detect.msvc' @($Info.msvc.version)) }
    $appText = Get-Msg 'detect.appMissing'
    if ($Info.app.serverExists) { $appText = Get-Msg 'detect.appOk' }
    Write-Host (Get-Msg 'detect.app' @($appText))
    $readyText = Get-Msg 'detect.readyNo'
    if ($Info.ready) { $readyText = Get-Msg 'detect.readyYes' }
    Write-Host (Get-Msg 'detect.ready' @($readyText)) -ForegroundColor Green
}

# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------
Initialize-Messages

if ($Help) {
    if ($script:Messages) {
        Write-Host (Get-Msg 'help.title') -ForegroundColor Cyan
        Write-Host (Get-Msg 'help.detect1')
        Write-Host (Get-Msg 'help.detect2')
    }
    exit 0
}

$script:Root = Resolve-Root
$info = Get-Detection

if ($Save) {
    if (Test-Path -LiteralPath $script:Root) {
        $dataDir = Join-Path $script:Root 'data'
        if (-not (Test-Path -LiteralPath $dataDir)) {
            [void](New-Item -ItemType Directory -Path $dataDir -Force -ErrorAction SilentlyContinue)
        }
        try {
            $json = $info | ConvertTo-Json -Depth 6
            [System.IO.File]::WriteAllText((Join-Path $dataDir 'env.json'), $json, $script:Utf8)
        } catch { }
    }
}

if ($Human) {
    Show-Human -Info $info
    exit 0
}

$info | ConvertTo-Json -Depth 6 -Compress
exit 0
