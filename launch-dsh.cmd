@echo off
chcp 65001 >nul
setlocal

rem ============================================================
rem  DSH 启动器（启动前自动清理累积的 dsh-auth-* cookie）
rem
rem  请把桌面 / 开始菜单 / 任务栏的 DeepSeek Harness 快捷方式
rem  指向本文件，而不是指向 DeepSeek Harness.exe。
rem
rem  设计理由：cookie 库在 DSH 运行期间被 Chromium 独占锁定，
rem  只能在启动前或退出后清理。每次启动前清一次，累积永远不会
rem  超过 1 条，从根上避免 16KB 请求头溢出导致的 431。
rem ============================================================

set "GUARD=%~dp0dsh-cookie-guard.mjs"
set "NODE="

where node >nul 2>nul && set "NODE=node"
if not defined NODE if exist "C:\Program Files\nodejs\node.exe" set "NODE=C:\Program Files\nodejs\node.exe"
if not defined NODE if exist "%LOCALAPPDATA%\Programs\nodejs\node.exe" set "NODE=%LOCALAPPDATA%\Programs\nodejs\node.exe"

if not defined NODE (
  rem 没有 node 就退化为直接启动，不让启动器本身成为故障点
  if exist "%LOCALAPPDATA%\Programs\DeepSeek Harness\DeepSeek Harness.exe" (
    start "" "%LOCALAPPDATA%\Programs\DeepSeek Harness\DeepSeek Harness.exe"
  )
  exit /b 0
)

"%NODE%" "%GUARD%" --launch
