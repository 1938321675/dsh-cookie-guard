@echo off
chcp 65001 >nul
setlocal

rem ============================================================
rem  DSH cookie 守卫 —— 预防启动报 "Web authentication failed"
rem  用法与本脚本同目录的 dsh-cookie-guard.mjs
rem ============================================================

set "SCRIPT=%~dp0dsh-cookie-guard.mjs"
set "NODE="

where node >nul 2>nul && set "NODE=node"
if not defined NODE if exist "C:\Program Files\nodejs\node.exe" set "NODE=C:\Program Files\nodejs\node.exe"
if not defined NODE if exist "%LOCALAPPDATA%\Programs\nodejs\node.exe" set "NODE=%LOCALAPPDATA%\Programs\nodejs\node.exe"

if not defined NODE (
  echo [x] 没找到 node.exe，请安装 Node.js 或在本脚本里指定路径。
  if "%~1"=="" pause
  exit /b 1
)

"%NODE%" "%SCRIPT%" %*
set "CODE=%ERRORLEVEL%"

if "%~1"=="" pause
exit /b %CODE%
