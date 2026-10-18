@echo off
rem One-time setup on Windows: Python packages for the backend, Node packages for the frontend.
setlocal
cd /d "%~dp0"

where python >nul 2>nul
if errorlevel 1 goto nopython
where npm >nul 2>nul
if errorlevel 1 goto nonode

echo [1/3] Creating the Python environment...
cd backend
if not exist .venv python -m venv .venv
if errorlevel 1 goto failed
call .venv\Scripts\activate.bat
python -m pip install --upgrade pip
pip install -r requirements-dev.txt
if errorlevel 1 goto failed
if not exist .env copy .env.example .env >nul

echo [2/3] Installing the frontend packages...
cd ..\frontend
call npm install
if errorlevel 1 goto failed
cd ..

echo [3/3] Done.
echo.
echo Next steps:
echo   1. Open backend\.env in Notepad and paste a free Gemini or Groq API key.
echo   2. Double-click start.bat.
echo.
pause
exit /b 0

:nopython
echo Python was not found. Install Python 3.11 or newer from python.org
echo and tick "Add python.exe to PATH" in the installer. Then run this again.
pause
exit /b 1

:nonode
echo Node.js was not found. Install the LTS version from nodejs.org, then run this again.
pause
exit /b 1

:failed
echo.
echo Setup stopped because a step failed. The message above says which one.
pause
exit /b 1
