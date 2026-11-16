@echo off
chcp 65001 >nul
cd /d "%~dp0"
set NODE=%~dp0runtime\node.exe
if not exist "%NODE%" set NODE=node
"%NODE%" -v || (echo Node.js не найден. Распакуйте архив полностью. & pause & exit /b 1)
"%NODE%" --test tests\
pause
