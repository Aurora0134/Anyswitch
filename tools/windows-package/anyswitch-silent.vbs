Set ws = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
If WScript.Arguments.Count < 1 Then WScript.Quit 1
root = fso.GetParentFolderName(WScript.ScriptFullName)
launcher = root & "\anyswitch.cmd"
cmd = """" & launcher & """"
For Each arg In WScript.Arguments
  cmd = cmd & " """ & Replace(CStr(arg), """", """""") & """"
Next
ws.Run cmd, 0, False
WScript.Quit 0
