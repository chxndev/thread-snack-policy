#!/usr/bin/env bash
# WSL2 안에서 실행: systemd 서비스로 자소서 에이전트 정적 서버를 등록한다.
#   bash deploy/wsl/install.sh            # 현재 사용자, 현재 저장소 경로
#   PORT=8080 bash deploy/wsl/install.sh
set -euo pipefail
DIR="$(cd "$(dirname "$0")/../.." && pwd)"
USER_NAME="${SUDO_USER:-$USER}"
PORT="${PORT:-8080}"

if ! command -v systemctl >/dev/null || ! systemctl is-system-running --quiet 2>/dev/null && [ "$(systemctl is-system-running 2>/dev/null)" != "degraded" ]; then
  cat <<MSG
systemd가 켜져 있지 않습니다. /etc/wsl.conf 에 아래를 넣고 Windows에서 'wsl --shutdown' 후 다시 여세요.
[boot]
systemd=true
MSG
  exit 1
fi

sed -e "s#__USER__#${USER_NAME}#g" -e "s#__DIR__#${DIR}#g" -e "s#8080#${PORT}#g" "$DIR/deploy/wsl/jaso.service" | sudo tee /etc/systemd/system/jaso.service >/dev/null
sudo systemctl daemon-reload
sudo systemctl enable --now jaso.service
sleep 1
systemctl --no-pager --lines=5 status jaso.service || true
echo
echo "열기: http://localhost:${PORT}/jaso/   (Windows 브라우저에서도 같은 주소)"
echo "로그: journalctl -u jaso -f   중지: sudo systemctl disable --now jaso"
