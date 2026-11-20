@ECHO off
SETLOCAL DisableDelayedExpansion
call "%~dp0anyswitch.cmd" "src\panel\panel-launcher.mjs" %*
EXIT /b %ERRORLEVEL%
