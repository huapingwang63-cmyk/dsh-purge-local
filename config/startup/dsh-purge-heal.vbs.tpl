' Logon launcher for the heal watchdog.
' Template only: install/register-tasks.ps1 substitutes the placeholder in the
' script path below with the absolute path to heal.ps1.
' Keep this file pure ASCII -- cscript reads .vbs as ANSI(936) and a UTF-8
' Chinese comment eats the following newline.
Set sh = CreateObject("WScript.Shell")
script = "__HEAL_PS1__"
sh.Run "powershell.exe -NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File """ & script & """", 0, False
