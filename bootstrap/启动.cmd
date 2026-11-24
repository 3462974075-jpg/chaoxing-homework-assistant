@echo off
rem Chaoxing Homework Assistant v1.4.0
rem Copyright (c) 2026 sevenplayer (Lsy). All rights reserved.
rem SPDX-License-Identifier: MIT
rem Powered by DeepSeek (AI-assisted development)
rem ChaoxingHomework portable launcher (ASCII only; Chinese text is in messages.json)
setlocal EnableExtensions
chcp 65001 >nul
title ChaoxingHomework
set "PS=%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe"
if not exist "%PS%" set "PS=powershell.exe"
"%PS%" -NoProfile -ExecutionPolicy Bypass -File "%~dp0start.ps1" %*
set "RC=%ERRORLEVEL%"
echo.
if not "%RC%"=="0" (
    "%PS%" -NoProfile -ExecutionPolicy Bypass -Command "$m = Get-Content -Raw -Encoding UTF8 '%~dp0messages.json' | ConvertFrom-Json; Write-Host $m.cmd.startFailed -ForegroundColor Red"
) else (
    "%PS%" -NoProfile -ExecutionPolicy Bypass -Command "$m = Get-Content -Raw -Encoding UTF8 '%~dp0messages.json' | ConvertFrom-Json; Write-Host $m.cmd.startWindowHint -ForegroundColor Green"
)
if not "%CX_NO_PAUSE%"=="1" pause
endlocal & exit /b %RC%
