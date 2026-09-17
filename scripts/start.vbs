' scripts/start.vbs - hidden start of node server
Set fso = CreateObject("Scripting.FileSystemObject")
Set shell = CreateObject("WScript.Shell")
scriptDir = fso.GetParentFolderName(WScript.ScriptFullName)
rootDir = fso.GetParentFolderName(scriptDir)
shell.CurrentDirectory = rootDir

dataDir = rootDir & "\data"
If Not fso.FolderExists(dataDir) Then fso.CreateFolder dataDir

nodeExe = "node"
portable = rootDir & "\tools\node\node.exe"
If fso.FileExists(portable) Then nodeExe = """" & portable & """"

' Prefer portable node; hide window; log to data\server-start.log
logOut = dataDir & "\server-start.log"
If fso.FileExists(logOut) Then fso.DeleteFile logOut, True
cmd = "cmd /c " & nodeExe & " src\validate-server.js >> """ & logOut & """ 2>&1"
shell.Run cmd, 0, False
