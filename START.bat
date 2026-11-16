@echo off
chcp 65001 >nul
cd /d "%~dp0"
set NODE=%~dp0runtime\node.exe
if not exist "%NODE%" set NODE=node
start "BYBIT24 JS" /min "%NODE%" "%~dp0supervisor.js"
