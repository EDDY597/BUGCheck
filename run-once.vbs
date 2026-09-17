' run-once.vbs - headless validation
' Always try to start tray (mutex keeps single instance), then run --once
' Prefer portable node under tools\node
Set fso = CreateObject("Scripting.FileSystemObject")
Set shell = CreateObject("WScript.Shell")
rootDir = fso.GetParentFolderName(WScript.ScriptFullName)
shell.CurrentDirectory = rootDir

dataDir = rootDir & "\data"
If Not fso.FolderExists(dataDir) Then fso.CreateFolder dataDir

nodeExe = "node"
portable = rootDir & "\tools\node\node.exe"
If fso.FileExists(portable) Then nodeExe = """" & portable & """"

Function PortListening()
  PortListening = False
  On Error Resume Next
  Dim exec, line
  Set exec = shell.Exec("cmd /c netstat -ano | findstr ""LISTENING"" | findstr "":3456""")
  Do While Not exec.StdOut.AtEndOfStream
    line = exec.StdOut.ReadLine
    If InStr(line, "LISTENING") > 0 Then
      PortListening = True
      Exit Do
    End If
  Loop
  exec.Terminate
  On Error GoTo 0
End Function

' Always launch tray (second instance exits via mutex). Tray starts server if needed.
trayVbs = rootDir & "\scripts\tray.vbs"
If fso.FileExists(trayVbs) Then
  shell.Run "wscript //nologo """ & trayVbs & """", 0, False
End If

If Not PortListening() Then
  Dim i
  For i = 1 To 20
    WScript.Sleep 1000
    If PortListening() Then Exit For
  Next
End If

shell.Run "cmd /c " & nodeExe & " src\validate-server.js --once", 0, True
