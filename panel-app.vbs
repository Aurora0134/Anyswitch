' panel-app.vbs - open the Anyswitch control panel (no console window)
'
' Desktop shortcut entry point. Launches panel-launcher.mjs which:
'   - probes the panel (127.0.0.1:47820); if it isn't running, starts
'     panel-host.mjs detached
'   - opens http://127.0.0.1:47820/panel in the default browser
'
' Uses the absolute node path when present (%ProgramFiles%\nodejs\node.exe),
' otherwise falls back to "node" resolved via PATH.
' Shows an error dialog when the launcher exits non-zero (no silent failure).
Set ws = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")

launcher = fso.GetParentFolderName(WScript.ScriptFullName) & "\panel-launcher.mjs"
nodePath = ws.ExpandEnvironmentStrings("%ProgramFiles%") & "\nodejs\node.exe"

If fso.FileExists(nodePath) Then
  cmd = """" & nodePath & """ """ & launcher & """"
Else
  ' PATH fallback: an unquoted "node" is required for PATH resolution
  cmd = "node """ & launcher & """"
End If

code = ws.Run(cmd, 0, True)
If code <> 0 Then
  MsgBox "Anyswitch panel failed to open (launcher exit code " & code & ")." & vbCrLf & _
         "Please make sure node is installed and check: " & launcher, _
         vbExclamation, "Anyswitch Panel"
End If
WScript.Quit(code)
