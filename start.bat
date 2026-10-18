@echo off
rem Starts the backend and the frontend in two windows, then opens the app.
cd /d "%~dp0"
if not exist backend\.venv goto notsetup

start "Aura backend" /D "%~dp0backend" cmd /k ".venv\Scripts\activate.bat && uvicorn app.main:app --port 8000"
start "Aura frontend" /D "%~dp0frontend" cmd /k "npm run dev"

echo Waiting for the servers to start...
timeout /t 7 /nobreak >nul
start "" http://localhost:5173
exit /b 0

:notsetup
echo Run setup.bat first.
pause
exit /b 1
