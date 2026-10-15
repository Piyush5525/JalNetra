@echo off
REM Starts JalNetra locally: the live backend + scheduled river monitor (port 8787), then the website (https://localhost:5173).
REM Set MONITOR_INTERVAL_MIN in .env to change the refresh interval (default 15 minutes).
cd /d "%~dp0aws-api" && call npx tsc
cd /d "%~dp0local-backend"
start "JalNetra live backend + monitor" cmd /k node server.mjs
cd /d "%~dp0"
start "JalNetra website" cmd /k npx vite
echo.
echo Website:  https://localhost:5173/live   (accept the certificate warning on a phone)
echo Monitor status: https://localhost:5173/monitor/status
