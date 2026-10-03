#!/usr/bin/env bash
# WSL2 안에서 실행: cloudflared 빠른 터널(quick tunnel)로 jaso 서버를 외부(https://….trycloudflare.com)에 공개한다.
#   bash deploy/wsl/install-tunnel.sh             # /etc/jaso/jaso.env 의 JASO_PORT 로 연결
#   bash deploy/wsl/install-tunnel.sh --port 8090
#   bash deploy/wsl/install-tunnel.sh --url       # 지금 터널 주소만 다시 출력
# 먼저 install.sh 로 jaso 서비스를 설치해야 한다. cloudflared 가 없으면 설치하고(apt 저장소 → .deb 내려받기 순),
# /etc/systemd/system/jaso-tunnel.service 를 등록하며, 환경 파일에 JASO_TRUST_PROXY=1 을 켠다.
# 다시 실행해도 안전하다(이미 있는 것은 건너뛰고, 터널만 다시 시작해 새 주소를 보여 준다).
# 주소가 바뀌지 않는 무료 대안: Tailscale Funnel — bash deploy/wsl/install-funnel.sh (도메인 불필요, README 참고).
set -euo pipefail

DIR="$(cd "$(dirname "$0")/../.." && pwd)"
ENV_FILE=/etc/jaso/jaso.env
UNIT_FILE=/etc/systemd/system/jaso-tunnel.service
HOME_DIR="${HOME:-/root}"
PORT=""
URL_ONLY=0
URL_WAIT_SEC="${URL_WAIT_SEC:-40}"

usage() {
  sed -n '2,9p' "$0" | sed 's/^# \{0,1\}//'
}

while [ $# -gt 0 ]; do
  case "$1" in
    --port)
      [ $# -ge 2 ] || { echo "--port 뒤에 포트 번호를 적어 주세요." >&2; exit 1; }
      PORT="$2"; shift 2 ;;
    --port=*) PORT="${1#--port=}"; shift ;;
    --url) URL_ONLY=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) echo "알 수 없는 옵션: $1" >&2; usage >&2; exit 1 ;;
  esac
done

# ── 유틸 (install.sh 와 같은 규칙) ─────────────────────────────────────────
sed_escape() { printf '%s' "$1" | sed -e 's/[\\&#]/\\&/g'; }
unit_escape() { sed_escape "$(printf '%s' "$1" | sed -e 's/%/%%/g')"; }
check_unit_safe() {
  local label="$1" value="$2"
  case "$value" in
    *'"'*|*\\*|*'$'*|*$'\n'*)
      echo "$label 에 유닛 파일에 넣을 수 없는 문자(\" \\ \$ 줄바꿈)가 있습니다: $value" >&2
      exit 1 ;;
  esac
}
env_get() {
  local key="$1"
  sudo grep -E "^${key}=" "$ENV_FILE" 2>/dev/null | tail -n 1 | sed -e "s/^${key}=//" -e 's/^"\(.*\)"$/\1/' || true
}
# 현재 실행 중인 터널의 로그에서 trycloudflare 주소를 찾는다(없으면 빈 문자열).
tunnel_url() {
  local inv
  inv="$(systemctl show -p InvocationID --value jaso-tunnel.service 2>/dev/null || true)"
  if [ -n "$inv" ]; then
    sudo journalctl _SYSTEMD_INVOCATION_ID="$inv" --no-pager -o cat 2>/dev/null \
      | grep -oE 'https://[a-z0-9-]+\.trycloudflare\.com' | tail -n 1 || true
  fi
}
print_url_block() {
  local url="$1" key
  key="$(env_get JASO_ACCESS_KEY)"
  echo
  echo "터널 주소: ${url}/jaso/"
  echo "접속 키:   ${key:-(설정 파일에 없음 — bash deploy/wsl/install.sh --print-key)}"
  echo "방문자는 위 주소를 열고 '설정'에 접속 키를 넣으면 됩니다. 주소와 키는 믿을 수 있는 소수에게만 전달하세요."
  echo "주의: 빠른 터널 주소는 터널(또는 PC/WSL)이 다시 시작될 때마다 바뀝니다. 다시 보려면: bash deploy/wsl/install-tunnel.sh --url"
  echo "      주소가 바뀌면 방문자에게 새 주소를 다시 알려야 하고, 폰 홈 화면에 추가한 아이콘도 옛 주소를 가리킵니다."
}

if [ "$(id -u)" -eq 0 ] && [ -n "${SUDO_USER:-}" ]; then
  echo "sudo 없이 본인 계정으로 실행해 주세요 (필요한 곳에서 sudo 비밀번호를 묻습니다)." >&2
  exit 1
fi

# ── --url ──────────────────────────────────────────────────────────────────
if [ "$URL_ONLY" = 1 ]; then
  if [ "$(systemctl is-active jaso-tunnel.service 2>/dev/null || true)" != "active" ]; then
    echo "jaso-tunnel 서비스가 실행 중이 아닙니다. bash deploy/wsl/install-tunnel.sh 로 설정하세요." >&2
    exit 1
  fi
  URL="$(tunnel_url)"
  if [ -z "$URL" ]; then
    echo "아직 터널 주소가 로그에 없습니다. 잠시 뒤 다시 시도하거나 journalctl -u jaso-tunnel -f 를 보세요." >&2
    exit 1
  fi
  print_url_block "$URL"
  exit 0
fi

# ── 1. 사전 조건: systemd, jaso 설치 ──────────────────────────────────────
SYSTEMD_STATE=""
if command -v systemctl >/dev/null 2>&1; then
  SYSTEMD_STATE="$(systemctl is-system-running 2>/dev/null || true)"
fi
case "$SYSTEMD_STATE" in
  running|degraded|starting) ;;
  *) echo "systemd가 켜져 있지 않습니다. 먼저 deploy/wsl/install.sh 의 안내대로 /etc/wsl.conf 에 systemd=true 를 넣으세요." >&2; exit 1 ;;
esac
if ! sudo test -f "$ENV_FILE" || ! systemctl cat jaso.service >/dev/null 2>&1; then
  echo "jaso 서비스가 아직 설치되지 않았습니다. 먼저 bash deploy/wsl/install.sh 를 실행하세요." >&2
  exit 1
fi
if [ -z "$PORT" ]; then
  PORT="$(env_get JASO_PORT)"
  PORT="${PORT:-8080}"
fi
case "$PORT" in
  ''|*[!0-9]*) echo "포트는 숫자여야 합니다: $PORT" >&2; exit 1 ;;
esac

TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT

# ── 2. cloudflared 설치 ────────────────────────────────────────────────────
install_cloudflared_apt() {
  # Debian/Ubuntu 공식 저장소. 코드명이 저장소에 없으면 실패하고 .deb 내려받기로 넘어간다.
  local codename=""
  if [ -r /etc/os-release ]; then
    # shellcheck disable=SC1091
    codename="$(. /etc/os-release && printf '%s' "${VERSION_CODENAME:-}")"
  fi
  if [ -z "$codename" ] && command -v lsb_release >/dev/null 2>&1; then
    codename="$(lsb_release -cs 2>/dev/null || true)"
  fi
  [ -n "$codename" ] || return 1
  sudo install -d -m 0755 /usr/share/keyrings
  curl -fsSL https://pkg.cloudflare.com/cloudflared.gpg | sudo tee /usr/share/keyrings/cloudflared.gpg >/dev/null || return 1
  echo "deb [signed-by=/usr/share/keyrings/cloudflared.gpg] https://pkg.cloudflare.com/cloudflared ${codename} main" \
    | sudo tee /etc/apt/sources.list.d/cloudflared.list >/dev/null
  if ! sudo apt-get update -qq -o Dir::Etc::sourcelist=/etc/apt/sources.list.d/cloudflared.list \
        -o Dir::Etc::sourceparts=- -o APT::Get::List-Cleanup=0 >/dev/null 2>&1; then
    echo "  cloudflared apt 저장소에 '${codename}' 이 없습니다. 저장소 설정을 지우고 .deb 로 설치합니다."
    sudo rm -f /etc/apt/sources.list.d/cloudflared.list
    return 1
  fi
  sudo apt-get install -y -qq cloudflared >/dev/null
}
install_cloudflared_deb() {
  local arch deb
  case "$(dpkg --print-architecture 2>/dev/null || uname -m)" in
    amd64|x86_64) arch=amd64 ;;
    arm64|aarch64) arch=arm64 ;;
    *) echo "지원하지 않는 아키텍처입니다: $(uname -m). https://github.com/cloudflare/cloudflared/releases 에서 직접 설치하세요." >&2; return 1 ;;
  esac
  deb="$TMP_DIR/cloudflared.deb"
  echo "  GitHub 릴리스에서 cloudflared-linux-${arch}.deb 를 내려받습니다…"
  curl -fsSL -o "$deb" "https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-${arch}.deb" || return 1
  sudo dpkg -i "$deb" >/dev/null || sudo apt-get install -y -f >/dev/null
}

CLOUDFLARED_BIN="$(command -v cloudflared 2>/dev/null || true)"
if [ -z "$CLOUDFLARED_BIN" ]; then
  if ! command -v apt-get >/dev/null 2>&1 || ! command -v dpkg >/dev/null 2>&1; then
    cat >&2 <<'MSG'
cloudflared 가 없고, 이 배포판은 apt 기반이 아니어서 자동 설치할 수 없습니다.
https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/ 를 참고해
cloudflared 를 설치한 뒤 다시 실행해 주세요.
MSG
    exit 1
  fi
  echo "cloudflared 설치 중…"
  if ! install_cloudflared_apt; then
    install_cloudflared_deb || { echo "cloudflared 설치에 실패했습니다." >&2; exit 1; }
  fi
  CLOUDFLARED_BIN="$(command -v cloudflared 2>/dev/null || true)"
  [ -n "$CLOUDFLARED_BIN" ] || { echo "cloudflared 를 설치했지만 PATH 에서 찾을 수 없습니다." >&2; exit 1; }
  echo "cloudflared 설치 완료: $CLOUDFLARED_BIN"
else
  echo "cloudflared 확인: $CLOUDFLARED_BIN ($("$CLOUDFLARED_BIN" --version 2>/dev/null | head -n 1 || true))"
fi
case "$CLOUDFLARED_BIN" in
  /mnt/[a-zA-Z]/*) echo "cloudflared 가 Windows 쪽 실행 파일입니다: $CLOUDFLARED_BIN — WSL 안에 설치해 주세요." >&2; exit 1 ;;
esac

# ── 3. 유닛 렌더링 ─────────────────────────────────────────────────────────
check_unit_safe "cloudflared 경로" "$CLOUDFLARED_BIN"
UNIT_TMP="$TMP_DIR/jaso-tunnel.service"
sed -e "s#__CLOUDFLARED__#$(unit_escape "$CLOUDFLARED_BIN")#g" \
    -e "s#__PORT__#$(unit_escape "$PORT")#g" \
    "$DIR/deploy/wsl/jaso-tunnel.service" > "$UNIT_TMP"
if grep -q '__[A-Z]*__' "$UNIT_TMP"; then
  echo "유닛 템플릿 치환이 끝나지 않았습니다. deploy/wsl/jaso-tunnel.service 를 확인하세요." >&2
  exit 1
fi
sudo install -m 0644 -o root -g root "$UNIT_TMP" "$UNIT_FILE"

# ── 4. JASO_TRUST_PROXY=1 (터널 뒤에서는 방문자 IP 를 CF-Connecting-IP 로 읽는다) ──
CURRENT_TRUST="$(env_get JASO_TRUST_PROXY)"
if [ "$CURRENT_TRUST" != "1" ]; then
  if sudo grep -qE '^[[:space:]]*#?[[:space:]]*JASO_TRUST_PROXY=' "$ENV_FILE"; then
    sudo sed -i -E 's/^[[:space:]]*#?[[:space:]]*JASO_TRUST_PROXY=.*/JASO_TRUST_PROXY=1/' "$ENV_FILE"
  else
    echo "JASO_TRUST_PROXY=1" | sudo tee -a "$ENV_FILE" >/dev/null
  fi
  sudo chmod 0600 "$ENV_FILE"
  echo "$ENV_FILE 에 JASO_TRUST_PROXY=1 설정 → jaso 재시작"
  sudo systemctl restart jaso.service
else
  echo "JASO_TRUST_PROXY=1 이미 설정됨"
fi

# ── 5. 터널 시작 + 주소 확인 ───────────────────────────────────────────────
sudo systemctl daemon-reload
sudo systemctl enable -q jaso-tunnel.service
sudo systemctl restart jaso-tunnel.service
echo "터널 주소를 기다리는 중 (최대 ${URL_WAIT_SEC}초)…"
URL=""
i=0
while [ "$i" -lt "$URL_WAIT_SEC" ]; do
  URL="$(tunnel_url)"
  [ -n "$URL" ] && break
  if [ "$(systemctl is-active jaso-tunnel.service 2>/dev/null || true)" = "failed" ]; then break; fi
  sleep 1
  i=$((i + 1))
done
if [ -z "$URL" ]; then
  echo "터널 주소를 아직 얻지 못했습니다. 최근 로그:" >&2
  sudo journalctl -u jaso-tunnel.service -n 30 --no-pager -o cat >&2 || true
  echo "잠시 뒤 bash deploy/wsl/install-tunnel.sh --url 로 다시 확인하거나 journalctl -u jaso-tunnel -f 를 보세요." >&2
  exit 1
fi
print_url_block "$URL"

cat <<RECIPE

고정 주소가 필요하면 둘 중 하나를 고르세요.

(권장) Tailscale Funnel — 무료, 도메인 불필요, 주소 https://<기기>.<tailnet>.ts.net/ 가 고정됩니다:
  bash deploy/wsl/install-funnel.sh
  Funnel 로 옮긴 뒤 빠른 터널이 필요 없으면: sudo systemctl disable --now jaso-tunnel

이름 있는 Cloudflare 터널 — Cloudflare 에 등록된 본인 도메인 필요(도메인 비용 별도). jaso.example.com 은 본인 호스트명으로:
  cloudflared tunnel login                      # 브라우저에서 Cloudflare 계정 인증
  cloudflared tunnel create jaso                # 터널 생성 — 출력되는 터널 ID 와 자격 증명 JSON 경로를 적어 둔다
  cloudflared tunnel route dns jaso jaso.example.com
  sudo mkdir -p /etc/cloudflared && sudo tee /etc/cloudflared/config.yml <<'YML'
tunnel: <터널 ID>
credentials-file: ${HOME_DIR}/.cloudflared/<터널 ID>.json
ingress:
  - hostname: jaso.example.com
    service: http://127.0.0.1:${PORT}
  - service: http_status:404
YML
  sudo systemctl disable --now jaso-tunnel      # 빠른 터널은 끄고
  sudo cloudflared service install              # /etc/cloudflared/config.yml 로 cloudflared.service 를 등록
그 뒤에는 https://jaso.example.com/jaso/ 로 접속합니다 (JASO_TRUST_PROXY=1 은 그대로 둡니다).
RECIPE
