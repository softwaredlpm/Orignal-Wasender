Set WshShell = CreateObject("WScript.Shell")
Set FSO = CreateObject("Scripting.FileSystemObject")
strPath = FSO.GetParentFolderName(WScript.ScriptFullName)
WshShell.CurrentDirectory = strPath

' Kill existing process on port 5000 (Avoids EADDRINUSE error)
WshShell.Run "cmd /c for /f ""tokens=5"" %a in ('netstat -ano ^| findstr :5000') do taskkill /PID %a /F", 0, True

' Wait 2 seconds for cleanup
WScript.Sleep 2000

' Run server.js hidden (0)
WshShell.Run "cmd /c node server.js", 0, False
