@echo off
setlocal EnableExtensions
set "ALPHION_ROOT=%~dp0"
pushd "%ALPHION_ROOT%" >nul 2>&1
if errorlevel 1 (
  echo [ERROR] Cannot enter the Alphion project directory: "%ALPHION_ROOT%" 1>&2
  exit /b 1
)

if not "%~1"=="" goto explicit

:menu
cls
call :check_runtime
if errorlevel 1 goto menu_unavailable
node "%ALPHION_ROOT%dist\cli\index.js" _launcher menu
choice /c 1234 /n /m "Select [1-4]: "
if errorlevel 4 goto menu_exit
if errorlevel 3 goto menu_help
if errorlevel 2 goto menu_doctor
if errorlevel 1 goto menu_tui
goto menu

:menu_tui
cls
node "%ALPHION_ROOT%dist\cli\index.js" tui --project-root "%ALPHION_ROOT%."
set "ALPHION_CODE=%ERRORLEVEL%"
if not "%ALPHION_CODE%"=="0" node "%ALPHION_ROOT%dist\cli\index.js" _launcher result --action TUI --code %ALPHION_CODE%
goto menu_pause

:menu_doctor
node "%ALPHION_ROOT%dist\cli\index.js" doctor --project-root "%ALPHION_ROOT%."
set "ALPHION_CODE=%ERRORLEVEL%"
if not "%ALPHION_CODE%"=="0" node "%ALPHION_ROOT%dist\cli\index.js" _launcher result --action doctor --code %ALPHION_CODE%
goto menu_pause

:menu_help
node "%ALPHION_ROOT%dist\cli\index.js" help
goto menu_pause

:menu_pause
echo.
pause
goto menu

:menu_unavailable
echo.
echo Press any key to close this window after reading the recovery command.
pause >nul
popd
exit /b 1

:menu_exit
popd
exit /b 0

:explicit
call :check_runtime
if errorlevel 1 goto explicit_runtime_error
node "%ALPHION_ROOT%dist\cli\index.js" %*
set "ALPHION_CODE=%ERRORLEVEL%"
popd
exit /b %ALPHION_CODE%

:explicit_runtime_error
popd
exit /b 1

:check_runtime
where node >nul 2>&1
if errorlevel 1 (
  echo [ERROR] Node.js was not found. Install Node.js 22.13 or newer and reopen the terminal. 1>&2
  exit /b 1
)
if not exist "%ALPHION_ROOT%dist\cli\index.js" (
  echo [ERROR] Alphion is not built; dist\cli\index.js is missing. 1>&2
  echo [RECOVERY] Run this command in the project directory: npm run build 1>&2
  exit /b 1
)
exit /b 0
