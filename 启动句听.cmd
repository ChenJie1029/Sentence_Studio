@echo off
chcp 65001 >nul
setlocal EnableExtensions DisableDelayedExpansion
title 句听 - 本地启动
cd /d "%~dp0"

if not exist "server.mjs" (
  echo 请把“启动句听.cmd”放到 server.mjs 所在的项目文件夹，再双击启动。
  echo 当前文件夹：%CD%
  pause
  exit /b 1
)
if not exist "dist\index.html" (
  echo 项目文件不完整，请先完整解压项目包，再运行启动文件。
  pause
  exit /b 1
)

set "SENTENCE_NODE="
if exist "%~dp0runtime\node.exe" set "SENTENCE_NODE=%~dp0runtime\node.exe"
if not defined SENTENCE_NODE if exist "%USERPROFILE%\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe" set "SENTENCE_NODE=%USERPROFILE%\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe"
if not defined SENTENCE_NODE if exist "%ProgramFiles%\nodejs\node.exe" set "SENTENCE_NODE=%ProgramFiles%\nodejs\node.exe"
if not defined SENTENCE_NODE if exist "%LOCALAPPDATA%\Programs\nodejs\node.exe" set "SENTENCE_NODE=%LOCALAPPDATA%\Programs\nodejs\node.exe"
if not defined SENTENCE_NODE for /f "delims=" %%N in ('where node.exe 2^>nul') do if not defined SENTENCE_NODE set "SENTENCE_NODE=%%N"

if not defined SENTENCE_NODE (
  echo 没有找到可用的 Node.js 运行环境。请安装 Node.js 后再次双击启动。
  pause
  exit /b 1
)

if /i "%~1"=="--check" (
  echo 已找到运行环境，项目文件齐全。
  "%SENTENCE_NODE%" --version
  exit /b 0
)

echo 正在启动句听，请保持此窗口打开。
echo 启动成功后，在浏览器打开：
echo http://127.0.0.1:4173/
echo.
echo 结束使用时，可以直接关闭此窗口。
echo.
"%SENTENCE_NODE%" "%~dp0server.mjs"
set "SENTENCE_EXIT=%ERRORLEVEL%"
if not "%SENTENCE_EXIT%"=="0" (
  echo.
  echo 启动未成功，请把上方错误信息发给我。
  echo 如果显示 EADDRINUSE，可能已经启动过，请先打开上方网页地址。
  pause
)
exit /b %SENTENCE_EXIT%
