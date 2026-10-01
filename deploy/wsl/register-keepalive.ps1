# Windows PowerShell(관리자 아님, 본인 계정)에서 실행:
#   powershell -ExecutionPolicy Bypass -File deploy\wsl\register-keepalive.ps1
# 로그온할 때마다 wsl-keepalive.vbs 를 창 없이 실행해 WSL VM을 계속 살려 둔다.
# WSL 안에서 돌아가는 jaso 서버(운영자 구독 모드, jaso.service)와 터널(jaso-tunnel.service)이 꺼지지 않게 하는 용도.
# PC를 끄지 않고 화면만 잠그는 경우에 적합. (로그아웃하거나 PC를 끄면 WSL 인스턴스도, 서버와 터널도 함께 멈춘다.)
$vbs = Join-Path $PSScriptRoot 'wsl-keepalive.vbs'
$action = New-ScheduledTaskAction -Execute 'wscript.exe' -Argument "`"$vbs`""
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit 0 -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1)
Register-ScheduledTask -TaskName 'WSL keepalive (jaso)' -Action $action -Trigger $trigger -Settings $settings -Force | Out-Null
Start-ScheduledTask -TaskName 'WSL keepalive (jaso)'
Write-Host '등록 완료. 확인: wsl -l -v  (Running 이어야 함)'
