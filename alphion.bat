@echo off
setlocal
set "ALPHION_ROOT=%~dp0"
if not exist "%ALPHION_ROOT%dist\cli\index.js" (
  echo Alphion is not built. Run npm run build from "%ALPHION_ROOT%" first. 1>&2
  exit /b 1
)
node "%ALPHION_ROOT%dist\cli\index.js" %*
exit /b %ERRORLEVEL%
