' Windows 쪽: WSL VM이 유휴 종료되지 않도록 창 없이 wsl.exe 프로세스를 하나 유지한다.
' 작업 스케줄러에 "로그온 시" 트리거로 등록해 쓴다 (register-keepalive.ps1 참고).
' 배포판 이름이 Ubuntu가 아니면 아래 -d 값을 바꾸세요 (wsl -l -v 로 확인).
CreateObject("WScript.Shell").Run "wsl.exe -d Ubuntu --exec sleep infinity", 0, False
