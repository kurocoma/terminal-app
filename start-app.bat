@echo off
setlocal
cd /d "%~dp0"

if not exist "node_modules\electron\dist\electron.exe" (
  echo [terminal-app] node_modules ������܂���B��� npm install �����s���Ă��������B
  pause
  exit /b 1
)

if not exist "dist\main\index.js" (
  echo [terminal-app] �r���h���ʕ�������܂���Bnpm run build �����s���܂�...
  call npm run build
  if errorlevel 1 (
    echo [terminal-app] �r���h�Ɏ��s���܂����B
    pause
    exit /b 1
  )
)

REM Electron ��؂藣���ċN�����A���� bat �̍�����ʂ͂�������
start "" /D "%~dp0" "%~dp0node_modules\electron\dist\electron.exe" . >nul 2>&1
exit /b 0