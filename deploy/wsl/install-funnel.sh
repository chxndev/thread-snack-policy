#!/usr/bin/env bash
# WSL2 안에서 실행: Tailscale Funnel 로 jaso 서버를 고정된 무료 HTTPS 주소(https://<기기>.<tailnet>.ts.net/)에 공개한다.
#   bash deploy/wsl/install-funnel.sh                    # /etc/jaso/jaso.env 의 JASO_PORT 를 공개 (Tailscale 기기 이름 jaso)
#   bash deploy/wsl/install-funnel.sh --hostname myjaso  # 기기 이름 지정 (이 스크립트가 처음 로그인시킬 때만 반영)
#   bash deploy/wsl/install-funnel.sh --port 8090
#   bash deploy/wsl/install-funnel.sh --url              # 지금 공개 주소만 다시 출력
#   bash deploy/wsl/install-funnel.sh --off              # 공개 중지 (sudo tailscale funnel reset)
# 먼저 install.sh 로 jaso 서비스를 설치해야 한다. Tailscale 이 없으면 설치하고, 로그인이 필요하면 브라우저 로그인 주소를 보여 준다.
# Funnel 은 Tailscale 무료(Personal) 요금제에 포함되며, 주소는 PC·WSL 을 다시 시작해도 바뀌지 않는다(--bg 설정이 저장됨).
# 다시 실행해도 안전하다(설치·로그인·설정이 이미 되어 있으면 건너뛰고, 공개 주소를 다시 보여 준다).
set -euo pipefail

ENV_FILE=/etc/jaso/jaso.env
PORT=""
HOSTNAME_ARG="jaso"
MODE=on
LOGIN_WAIT_SEC="${LOGIN_WAIT_SEC:-600}"
HEALTH_WAIT_SEC="${HEALTH_WAIT_SEC:-150}" # auth status 15초 + 로그인 점검 90초 + claude doctor 20초 + 여유
PUBLIC_WAIT_SEC="${PUBLIC_WAIT_SEC:-60}"

usage() {
  sed -n '2,10p' "$0" | sed 's/^# \{0,1\}//'
}

while [ $# -gt 0 ]; do
  case "$1" in
    --port)
      [ $# -ge 2 ] || { echo "--port 뒤에 포트 번호를 적어 주세요." >&2; exit 1; }
      PORT="$2"; shift 2 ;;
    --port=*) PORT="${1#--port=}"; shift ;;
    --hostname)
      [ $# -ge 2 ] || { echo "--hostname 뒤에 기기 이름을 적어 주세요." >&2; exit 1; }
      HOSTNAME_ARG="$2"; shift 2 ;;
    --hostname=*) HOSTNAME_ARG="${1#--hostname=}"; shift ;;
    --url) MODE=url; shift ;;
    --off) MODE=off; shift ;;
    -h|--help) usage; exit 0 ;;
    *) echo "알 수 없는 옵션: $1" >&2; usage >&2; exit 1 ;;
  esac
done

HOSTNAME_ARG="$(printf '%s' "$HOSTNAME_ARG" | tr '[:upper:]' '[:lower:]')"
if ! [[ "$HOSTNAME_ARG" =~ ^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$ ]]; then
  echo "기기 이름은 영문 소문자·숫자·하이픈(-)만, 63자 이하로 적어 주세요: $HOSTNAME_ARG" >&2
  exit 1
fi

# ── 유틸 (install.sh 와 같은 규칙) ─────────────────────────────────────────
# 환경 파일에서 KEY=값 한 줄을 읽는다(없으면 빈 문자열). 파일은 root 전용이라 sudo 가 필요하다.
env_get() {
  local key="$1"
  sudo grep -E "^${key}=" "$ENV_FILE" 2>/dev/null | tail -n 1 | sed -e "s/^${key}=//" -e 's/^"\(.*\)"$/\1/' || true
}
# 표준 입력의 JSON 에서 간단한 필드를 꺼내 한 줄로 출력한다(node 사용, 없으면 빈 문자열).
json_field() {
  node -e '
    let s = ""; process.stdin.on("data", (d) => { s += d; }).on("end", () => {
      let j = null; try { j = JSON.parse(s.trim()); } catch { j = null; }
      const v = process.argv[1].split(".").reduce((o, k) => (o == null ? undefined : o[k]), j);
      process.stdout.write(v === undefined || v === null ? "" : String(v));
    });' "$1"
}
# tailscale status --json 의 BackendState (Running · NeedsLogin · Stopped …, 데몬이 없으면 빈 문자열)
backend_state() {
  sudo tailscale status --json 2>/dev/null | json_field BackendState || true
}
# 이 기기의 MagicDNS 이름 (끝의 점 제거)
self_dns() {
  { sudo tailscale status --json 2>/dev/null || true; } | json_field Self.DNSName | sed -e 's/\.$//'
}
# 지금 켜져 있는 Funnel 주소(https://<기기>.<tailnet>.ts.net[:포트]). 이 포트로 가는 것을 먼저 고르고, 없으면 빈 문자열.
funnel_url() {
  local url
  url="$({ sudo tailscale funnel status --json 2>/dev/null || true; } | node -e '
    let s = ""; process.stdin.on("data", (d) => { s += d; }).on("end", () => {
      let j = null; try { j = JSON.parse(s.trim() || "null"); } catch { j = null; }
      const allow = (j && j.AllowFunnel) || {};
      const web = (j && j.Web) || {};
      const hosts = Object.keys(allow).filter((k) => allow[k]);
      const port = process.argv[1];
      const proxies = (hp) => Object.values((web[hp] && web[hp].Handlers) || {}).map((h) => String((h && h.Proxy) || ""));
      const toPort = (hp) => proxies(hp).some((p) => p.replace(/\/+$/, "").endsWith(":" + port));
      const pick = hosts.find(toPort) || hosts[0] || "";
      if (!pick) return;
      const i = pick.lastIndexOf(":");
      const host = i > 0 ? pick.slice(0, i) : pick;
      const p = i > 0 ? pick.slice(i + 1) : "443";
      if (!/^[a-z0-9.-]+$/i.test(host)) return;
      process.stdout.write("https://" + host.toLowerCase() + (p === "443" ? "" : ":" + p));
    });' "${PORT:-8080}" 2>/dev/null || true)"
  if [ -z "$url" ]; then
    # JSON 모양이 다르면 사람이 읽는 출력에서 "Funnel on" 줄의 주소를 찾는다
    url="$({ sudo tailscale funnel status 2>/dev/null || true; } | grep -i 'funnel on' \
      | grep -oE 'https://[a-z0-9-]+\.[a-z0-9-]+\.ts\.net(:[0-9]+)?' | head -n 1 || true)"
  fi
  printf '%s' "$url"
}
print_url_block() {
  local url="$1" key
  key="$(env_get JASO_ACCESS_KEY)"
  echo
  echo "공개 주소: ${url}/jaso/"
  echo "접속 키:   ${key:-(설정 파일에 없음 — bash deploy/wsl/install.sh --print-key)}"
  echo "방문자는 위 주소를 열고 '설정'에 접속 키를 넣으면 됩니다(방문자는 Tailscale 을 설치할 필요가 없습니다)."
  echo "주소와 키는 믿을 수 있는 소수에게만 전달하세요."
  echo "이 주소는 고정입니다: PC·WSL 을 다시 시작해도 바뀌지 않습니다. Funnel 은 Tailscale 무료(Personal) 요금제에 포함됩니다."
  echo "폰에서는 이 주소를 열어 '홈 화면에 추가'하면 앱처럼 쓸 수 있습니다(README 의 '폰에 설치' 참고)."
  echo "다시 보기: bash deploy/wsl/install-funnel.sh --url    공개 중지: bash deploy/wsl/install-funnel.sh --off"
}

if [ "$(id -u)" -eq 0 ] && [ -n "${SUDO_USER:-}" ]; then
  echo "sudo 없이 본인 계정으로 실행해 주세요 (필요한 곳에서 sudo 비밀번호를 묻습니다)." >&2
  exit 1
fi

# ── --off ──────────────────────────────────────────────────────────────────
if [ "$MODE" = off ]; then
  if ! command -v tailscale >/dev/null 2>&1; then
    echo "Tailscale 이 설치되어 있지 않아 끌 Funnel 이 없습니다."
    exit 0
  fi
  sudo tailscale funnel reset
  echo "Funnel 공개를 껐습니다(이 기기의 Tailscale serve/funnel 설정을 모두 지웠습니다). 이제 외부에서 접속할 수 없습니다."
  echo "Tailscale 연결 자체는 그대로입니다. 다시 켜면 같은 주소로 공개됩니다: bash deploy/wsl/install-funnel.sh"
  exit 0
fi

# ── 포트 (설정 파일 → 기본 8080) ────────────────────────────────────────────
if [ -z "$PORT" ]; then
  PORT="$(env_get JASO_PORT)"
  PORT="${PORT:-8080}"
fi
case "$PORT" in
  ''|*[!0-9]*) echo "포트는 숫자여야 합니다: $PORT" >&2; exit 1 ;;
esac
if [ "$PORT" -lt 1 ] || [ "$PORT" -gt 65535 ]; then
  echo "포트는 1~65535 사이여야 합니다: $PORT" >&2; exit 1
fi

# ── --url ──────────────────────────────────────────────────────────────────
if [ "$MODE" = url ]; then
  if ! command -v tailscale >/dev/null 2>&1; then
    echo "Tailscale 이 설치되어 있지 않습니다. bash deploy/wsl/install-funnel.sh 로 설정하세요." >&2
    exit 1
  fi
  URL="$(funnel_url)"
  if [ -z "$URL" ]; then
    echo "Funnel 이 켜져 있지 않습니다. bash deploy/wsl/install-funnel.sh 로 켜세요. (상태: sudo tailscale funnel status)" >&2
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
if ! command -v node >/dev/null 2>&1; then
  echo "node 를 찾을 수 없습니다. install.sh 를 실행한 같은 사용자로 실행해 주세요." >&2
  exit 1
fi

TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT

# ── 2. Tailscale 설치 + 데몬 시작 ──────────────────────────────────────────
TS_BIN="$(command -v tailscale 2>/dev/null || true)"
if [ -z "$TS_BIN" ]; then
  echo "Tailscale 설치 중… (공식 설치 스크립트, 보통 1~2분)"
  if ! curl -fsSL https://tailscale.com/install.sh | sh; then
    echo "Tailscale 설치에 실패했습니다. https://tailscale.com/download/linux 의 안내로 직접 설치한 뒤 다시 실행해 주세요." >&2
    exit 1
  fi
  TS_BIN="$(command -v tailscale 2>/dev/null || true)"
  [ -n "$TS_BIN" ] || { echo "Tailscale 을 설치했지만 PATH 에서 tailscale 을 찾을 수 없습니다. 새 셸을 열고 다시 실행해 주세요." >&2; exit 1; }
  echo "Tailscale 설치 완료: $TS_BIN"
else
  echo "Tailscale 확인: $TS_BIN ($("$TS_BIN" version 2>/dev/null | head -n 1 || true))"
fi
case "$TS_BIN" in
  /mnt/[a-zA-Z]/*) echo "tailscale 이 Windows 쪽 실행 파일입니다: $TS_BIN — WSL 안에 설치해 주세요." >&2; exit 1 ;;
esac
sudo systemctl enable --now tailscaled >/dev/null 2>&1 || sudo systemctl enable --now tailscaled
# 데몬이 소켓을 열 때까지 잠깐 기다린다
i=0
while [ "$i" -lt 15 ] && [ -z "$(backend_state)" ]; do sleep 1; i=$((i + 1)); done
if [ -z "$(backend_state)" ]; then
  echo "tailscaled 가 응답하지 않습니다. 로그: journalctl -u tailscaled -n 30" >&2
  exit 1
fi

# ── 3. Tailscale 로그인 (처음 한 번) ───────────────────────────────────────
STATE="$(backend_state)"
if [ "$STATE" = "Running" ]; then
  echo "Tailscale 연결됨: $(self_dns)"
else
  cat <<MSG

Tailscale 에 이 PC 를 연결합니다 (처음 한 번만, 보통 2~3분).
  1) 곧 아래에 https://login.tailscale.com/… 로 시작하는 주소가 나옵니다. 그 주소를 Windows 브라우저에서 여세요
     (Windows Terminal 이면 Ctrl+클릭, 아니면 주소를 드래그해 복사한 뒤 브라우저 주소창에 붙여 넣기).
  2) Google·Microsoft·GitHub·Apple 계정 등으로 로그인합니다. 처음이면 이때 무료 계정과 내 Tailscale 네트워크(tailnet)가 만들어집니다.
  3) 브라우저에 이 기기(${HOSTNAME_ARG})를 연결하는 버튼(Connect)이 보이면 누릅니다. 끝나면 이 터미널이 저절로 다음 단계로 넘어갑니다.
최대 $((LOGIN_WAIT_SEC / 60))분 기다립니다. 그만두려면 Ctrl+C.

MSG
  UP_RC=0
  sudo timeout "$LOGIN_WAIT_SEC" tailscale up --hostname "$HOSTNAME_ARG" || UP_RC=$?
  # up 이 끝난 뒤에도 Running 이 되기까지 잠깐 걸릴 수 있다
  i=0
  while [ "$i" -lt 30 ] && [ "$(backend_state)" != "Running" ]; do sleep 1; i=$((i + 1)); done
  STATE="$(backend_state)"
  if [ "$STATE" != "Running" ]; then
    echo >&2
    if [ "$UP_RC" -eq 124 ]; then
      echo "$((LOGIN_WAIT_SEC / 60))분 안에 로그인이 끝나지 않았습니다 (상태: ${STATE:-알 수 없음})." >&2
    else
      echo "Tailscale 연결에 실패했습니다 (상태: ${STATE:-알 수 없음}, 종료 코드 $UP_RC). 위의 오류 문구를 확인하세요." >&2
    fi
    if [ "$STATE" = "NeedsMachineAuth" ]; then
      echo "관리 콘솔에서 이 기기를 승인해야 합니다: https://login.tailscale.com/admin/machines 에서 ${HOSTNAME_ARG} 의 Approve." >&2
    fi
    echo "다시 실행하면 이어서 진행합니다: bash deploy/wsl/install-funnel.sh" >&2
    exit 1
  fi
  echo "Tailscale 연결됨: $(self_dns)"
fi

# ── 4. Funnel 켜기 (https://<기기>.<tailnet>.ts.net/ → http://127.0.0.1:PORT) ──
DNS_NAME="$(self_dns)"
echo
echo "Funnel 켜는 중: 외부 https://${DNS_NAME:-<기기>.<tailnet>.ts.net}/ → 이 PC 의 http://127.0.0.1:${PORT}"
FUNNEL_OUT="$TMP_DIR/funnel.out"
FUNNEL_RC=0
# 출력은 그대로 보여 준다(Tailscale 이 승인 주소를 띄우고 기다리는 경우가 있어서). 최대 LOGIN_WAIT_SEC 초.
# 기다리는 동안 영어 문구만 보이지 않도록 미리 한국어로 안내한다.
echo "  Tailscale 이 \"To enable, visit: https://login.tailscale.com/…\" 같은 주소를 보여 주면 그 주소를 Windows 브라우저에서 열어 Enable(허용)을 누르세요."
echo "  이 터미널은 최대 $((LOGIN_WAIT_SEC / 60))분 기다렸다가 이어서 진행합니다."
sudo timeout "$LOGIN_WAIT_SEC" tailscale funnel --bg "$PORT" 2>&1 | tee "$FUNNEL_OUT" || FUNNEL_RC=$?
if [ "$FUNNEL_RC" -ne 0 ]; then
  HTTPS_LINK="$(grep -oE 'https://tailscale\.com/s/https' "$FUNNEL_OUT" | head -n 1 || true)"
  NOFUNNEL_LINK="$(grep -oE 'https://tailscale\.com/s/no-funnel' "$FUNNEL_OUT" | head -n 1 || true)"
  {
    echo
    echo "Funnel 을 켜지 못했습니다. Tailscale 관리 콘솔에서 아래 두 가지를 한 번씩 켜야 합니다(처음 한 번만, 각각 클릭 한두 번)."
    if [ -n "$HTTPS_LINK" ]; then
      echo "  ▶ 지금 걸린 것: HTTPS 인증서가 꺼져 있음 — $HTTPS_LINK"
    fi
    if [ -n "$NOFUNNEL_LINK" ]; then
      echo "  ▶ 지금 걸린 것: funnel 속성이 없음 — $NOFUNNEL_LINK"
    fi
    echo
    echo "  ① HTTPS 인증서 켜기 (안내: https://tailscale.com/s/https)"
    echo "     https://login.tailscale.com/admin/dns 를 열고 'HTTPS Certificates' 의 'Enable HTTPS' 를 누릅니다."
    echo "     (같은 페이지의 MagicDNS 가 꺼져 있으면 먼저 켜세요.)"
    echo "  ② Funnel 허용 (안내: https://tailscale.com/s/no-funnel)"
    echo "     https://login.tailscale.com/admin/acls 의 정책 파일에 funnel 속성이 있어야 합니다. 없으면 아래를 넣고 저장합니다:"
    echo '       "nodeAttrs": [ { "target": ["autogroup:member"], "attr": ["funnel"] } ]'
    echo
    echo "  위 출력에 https://login.tailscale.com/… 승인 주소가 따로 보였다면 그 주소를 열어 안내대로 승인해도 됩니다."
    echo "  켠 뒤 다시 실행하세요: bash deploy/wsl/install-funnel.sh"
  } >&2
  exit 1
fi

URL="$(funnel_url)"
if [ -z "$URL" ] && [ -n "$DNS_NAME" ]; then URL="https://${DNS_NAME}"; fi
if [ -z "$URL" ]; then
  echo "Funnel 은 켰지만 주소를 읽지 못했습니다. sudo tailscale funnel status 로 확인하세요." >&2
  exit 1
fi

# ── 5. JASO_TRUST_PROXY=1 (Funnel 은 방문자 IP 를 X-Forwarded-For 로 넘긴다) ──
RESTARTED=0
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
  RESTARTED=1
else
  echo "JASO_TRUST_PROXY=1 이미 설정됨"
fi

# ── 6. 동작 확인 (로컬 → 공개 주소) ────────────────────────────────────────
LOCAL_HEALTH="http://127.0.0.1:${PORT}/api/health"
if [ "$RESTARTED" = 1 ]; then
  echo "jaso 재시작 대기 중 (최대 ${HEALTH_WAIT_SEC}초, 시작 시 Claude 로그인·조직 설정 점검 때문에 1~2분 걸릴 수 있습니다)…"
fi
i=0
LOCAL_OK=0
while [ "$i" -lt "$HEALTH_WAIT_SEC" ]; do
  if curl -fsS --max-time 3 "$LOCAL_HEALTH" >/dev/null 2>&1; then LOCAL_OK=1; break; fi
  if [ "$(systemctl is-active jaso.service 2>/dev/null || true)" = "failed" ]; then break; fi
  sleep 1
  i=$((i + 1))
done
if [ "$LOCAL_OK" != 1 ]; then
  echo "주의: jaso 서버가 아직 응답하지 않습니다 ($LOCAL_HEALTH). 로그: journalctl -u jaso -f" >&2
else
  # 처음에는 인증서 발급 때문에 첫 응답이 늦을 수 있다. 여기서 한 번 불러 두면 첫 방문자가 기다리지 않는다.
  echo "공개 주소 확인 중 (최대 ${PUBLIC_WAIT_SEC}초, 처음에는 HTTPS 인증서 발급에 시간이 걸립니다)…"
  i=0
  PUBLIC_OK=0
  while [ "$i" -lt "$PUBLIC_WAIT_SEC" ]; do
    if curl -fsS --max-time 10 "${URL}/api/health" >/dev/null 2>&1; then PUBLIC_OK=1; break; fi
    sleep 5
    i=$((i + 5))
  done
  if [ "$PUBLIC_OK" = 1 ]; then
    echo "공개 주소 응답 확인: ${URL}/api/health"
  else
    echo "이 PC 에서는 아직 공개 주소가 응답하지 않습니다. 처음 켠 직후에는 몇 분 걸릴 수 있으니,"
    echo "잠시 뒤 휴대폰(와이파이를 끄고 LTE/5G)으로 아래 주소를 열어 확인해 보세요."
  fi
fi

print_url_block "$URL"

if [ "$(systemctl is-active jaso-tunnel.service 2>/dev/null || true)" = "active" ]; then
  echo
  echo "참고: cloudflared 빠른 터널(jaso-tunnel)도 켜져 있습니다. 함께 써도 되지만, 필요 없으면 끄세요:"
  echo "  sudo systemctl disable --now jaso-tunnel"
fi
