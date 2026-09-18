Set WshShell = CreateObject("WScript.Shell")
' Kill node process on port 5000 silently
WshShell.Run "cmd /c for /f ""tokens=5"" %a in ('netstat -ano ^| findstr :5000 ^| findstr LISTENING') do taskkill /PID %a /F 2>nul", 0, True
