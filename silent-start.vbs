' silent-start.vbs - launch a node script with NO console window.
'
' Scheduled-task entry point. Task Scheduler's Exec action has no "hidden
' window" option, so pointing it straight at node.exe pops a console at every
' logon. wscript + Run(cmd, 0) is the windowless path (same trick as
' panel-app.vbs). Node is spawned detached: when wscript exits immediately,
' the node child keeps running.
'
' Usage: wscript.exe silent-start.vbs "<absolute\path\to\script.mjs>"
Set ws = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")

If WScript.Arguments.Count < 1 Then
  WScript.Quit 1
End If
script = WScript.Arguments(0)

nodePath = ws.ExpandEnvironmentStrings("%ProgramFiles%") & "\nodejs\node.exe"
If fso.FileExists(nodePath) Then
  cmd = """" & nodePath & """ """ & script & """"
Else
  ' PATH fallback: an unquoted "node" is required for PATH resolution
  cmd = "node """ & script & """"
End If

ws.Run cmd, 0, False
WScript.Quit 0
