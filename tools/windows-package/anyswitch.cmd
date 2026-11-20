@ECHO off
SETLOCAL DisableDelayedExpansion
SET "VERSION_FILE=%TEMP%\anyswitch-version-%RANDOM%-%RANDOM%.txt"
"%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe" -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "%~dp0dispatch.ps1" -VersionOnly > "%VERSION_FILE%"
IF ERRORLEVEL 1 GOTO :failed
SET "ANYSWITCH_SELECTED_VERSION="
FOR /F "usebackq delims=" %%V IN ("%VERSION_FILE%") DO SET "ANYSWITCH_SELECTED_VERSION=%%V"
DEL /q "%VERSION_FILE%" >NUL 2>NUL
IF NOT DEFINED ANYSWITCH_SELECTED_VERSION GOTO :failed
SET "VERSION_ROOT=%~dp0versions\%ANYSWITCH_SELECTED_VERSION%"
"%VERSION_ROOT%\runtime\node.exe" "%VERSION_ROOT%\app\package-dispatch.mjs" %*
EXIT /b %ERRORLEVEL%
:failed
DEL /q "%VERSION_FILE%" >NUL 2>NUL
EXIT /b 1
