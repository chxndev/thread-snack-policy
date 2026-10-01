#!/usr/bin/env bash
# WSL2 안에서 실행: 자소서 에이전트 서버(운영자 구독 모드)를 systemd 서비스로 등록한다.
#   bash deploy/wsl/install.sh                # 현재 사용자, 현재 저장소 경로, 포트 8080
#   bash deploy/wsl/install.sh --port 8090    # 포트 변경 (처음 설치할 때만 반영된다)
#   bash deploy/wsl/install.sh --tunnel       # 설치 뒤 cloudflared 터널(install-tunnel.sh)까지 설정
#   bash deploy/wsl/install.sh --print-key    # 저장된 접속 키만 출력
# 서버는 127.0.0.1 에만 바인딩되고, 방문자는 접속 키(JASO_ACCESS_KEY)로 인증한다.
# 설정은 /etc/jaso/jaso.env (root 전용 0600) 에, 유닛은 /etc/systemd/system/jaso.service 에 쓴다.
# 다시 실행해도 안전하다: 기존 설정 파일은 덮어쓰지 않고 유닛만 다시 렌더링한 뒤 서비스를 재시작한다.
set -euo pipefail

DIR="$(cd "$(dirname "$0")/../.." && pwd)"
ENV_DIR=/etc/jaso
ENV_FILE=/etc/jaso/jaso.env
UNIT_FILE=/etc/systemd/system/jaso.service
PORT="${PORT:-8080}"
WITH_TUNNEL=0
PRINT_KEY=0
HEALTH_WAIT_SEC="${HEALTH_WAIT_SEC:-120}"

usage() {
  sed -n '2,8p' "$0" | sed 's/^# \{0,1\}//'
}

while [ $# -gt 0 ]; do
  case "$1" in
    --port)
      [ $# -ge 2 ] || { echo "--port 뒤에 포트 번호를 적어 주세요." >&2; exit 1; }
      PORT="$2"; shift 2 ;;
    --port=*) PORT="${1#--port=}"; shift ;;
    --tunnel) WITH_TUNNEL=1; shift ;;
    --print-key) PRINT_KEY=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) echo "알 수 없는 옵션: $1" >&2; usage >&2; exit 1 ;;
  esac
done

case "$PORT" in
  ''|*[!0-9]*) echo "포트는 숫자여야 합니다: $PORT" >&2; exit 1 ;;
esac
if [ "$PORT" -lt 1 ] || [ "$PORT" -gt 65535 ]; then
  echo "포트는 1~65535 사이여야 합니다: $PORT" >&2; exit 1
fi

# ── 유틸 ────────────────────────────────────────────────────────────────
# sed 치환문의 오른쪽(치환 문자열)에 넣기 위해 \ & 와 구분자 # 를 이스케이프한다.
sed_escape() { printf '%s' "$1" | sed -e 's/[\\&#]/\\&/g'; }
# systemd 유닛 값에 넣기 위해 % 지정자(%h, %i …)를 %% 로 바꾼 뒤 sed 용으로 이스케이프한다.
unit_escape() { sed_escape "$(printf '%s' "$1" | sed -e 's/%/%%/g')"; }
# 유닛 파일에 안전하게 넣을 수 없는 문자가 경로에 있으면 멈춘다.
check_unit_safe() {
  local label="$1" value="$2"
  case "$value" in
    *'"'*|*\\*|*'$'*|*$'\n'*)
      echo "$label 에 유닛 파일에 넣을 수 없는 문자(\" \\ \$ 줄바꿈)가 있습니다: $value" >&2
      echo "저장소나 홈 디렉터리 경로를 바꾼 뒤 다시 실행해 주세요." >&2
      exit 1 ;;
  esac
}
# /mnt/<드라이브>/ 아래는 Windows 쪽 실행 파일(interop)이므로 systemd 서비스에서 쓸 수 없다.
check_linux_binary() {
  local label="$1" value="$2"
  case "$value" in
    /mnt/[a-zA-Z]/*)
      echo "$label 가 Windows 쪽 실행 파일을 가리킵니다: $value" >&2
      echo "WSL(Linux) 안에 $label 를 설치한 뒤 다시 실행해 주세요." >&2
      exit 1 ;;
  esac
}
# 환경 파일에서 KEY=값 한 줄을 읽는다(없으면 빈 문자열). 파일은 root 전용이라 sudo 가 필요하다.
env_get() {
  local key="$1"
  sudo grep -E "^${key}=" "$ENV_FILE" 2>/dev/null | tail -n 1 | sed -e "s/^${key}=//" -e 's/^"\(.*\)"$/\1/' || true
}
# 표준 입력의 JSON 에서 간단한 필드를 꺼내 한 줄로 출력한다(node 사용).
json_field() {
  node -e '
    let s = ""; process.stdin.on("data", (d) => { s += d; }).on("end", () => {
      let j = null; try { j = JSON.parse(s.trim()); } catch { j = null; }
      const v = process.argv[1].split(".").reduce((o, k) => (o == null ? undefined : o[k]), j);
      process.stdout.write(v === undefined || v === null ? "" : String(v));
    });' "$1"
}

TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT

# ── --print-key ──────────────────────────────────────────────────────────
if [ "$PRINT_KEY" = 1 ]; then
  if ! sudo test -f "$ENV_FILE"; then
    echo "아직 설치되지 않았습니다 ($ENV_FILE 없음). 먼저 bash deploy/wsl/install.sh 를 실행하세요." >&2
    exit 1
  fi
  KEY="$(env_get JASO_ACCESS_KEY)"
  if [ -z "$KEY" ]; then
    echo "$ENV_FILE 에 JASO_ACCESS_KEY 가 없습니다." >&2
    exit 1
  fi
  echo "$KEY"
  exit 0
fi

# ── 0. 실행 사용자 ────────────────────────────────────────────────────────
if [ "$(id -u)" -eq 0 ] && [ -n "${SUDO_USER:-}" ]; then
  echo "sudo 없이 본인 계정으로 실행해 주세요 (필요한 곳에서 sudo 비밀번호를 묻습니다)." >&2
  echo "  bash deploy/wsl/install.sh" >&2
  exit 1
fi
USER_NAME="$(id -un)"
HOME_DIR="$(getent passwd "$USER_NAME" | cut -d: -f6 || true)"
HOME_DIR="${HOME_DIR:-$HOME}"
if [ "$(id -u)" -eq 0 ]; then
  echo "주의: root 계정으로 설치합니다. 서비스도 root 로 실행되며 claude 로그인도 root 의 것을 씁니다."
fi

# ── 1. systemd ────────────────────────────────────────────────────────────
SYSTEMD_STATE=""
if command -v systemctl >/dev/null 2>&1; then
  SYSTEMD_STATE="$(systemctl is-system-running 2>/dev/null || true)"
fi
case "$SYSTEMD_STATE" in
  running|degraded|starting) ;;
  *)
    cat >&2 <<'MSG'
systemd가 켜져 있지 않습니다. /etc/wsl.conf 에 아래를 넣고 Windows에서 'wsl --shutdown' 후 다시 여세요.
[boot]
systemd=true
MSG
    exit 1 ;;
esac

# ── 2. node >= 18 ─────────────────────────────────────────────────────────
NODE_BIN="$(command -v node 2>/dev/null || true)"
if [ -z "$NODE_BIN" ]; then
  cat >&2 <<'MSG'
node 를 찾을 수 없습니다. Node.js 18 이상을 WSL 안에 설치하세요. 예)
  # NodeSource (Ubuntu/Debian)
  curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash - && sudo apt-get install -y nodejs
  # 또는 nvm
  curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/master/install.sh | bash && nvm install 22
MSG
  exit 1
fi
check_linux_binary node "$NODE_BIN"
NODE_MAJOR="$("$NODE_BIN" -p 'Number(process.versions.node.split(".")[0])' 2>/dev/null || echo 0)"
if [ "${NODE_MAJOR:-0}" -lt 18 ]; then
  echo "node 18 이상이 필요합니다. 현재: $("$NODE_BIN" --version 2>/dev/null || echo '알 수 없음') ($NODE_BIN)" >&2
  echo "  NodeSource(https://deb.nodesource.com) 나 nvm 으로 최신 LTS 를 설치하세요." >&2
  exit 1
fi

# ── 3. claude CLI ─────────────────────────────────────────────────────────
CLAUDE_BIN="$(command -v claude 2>/dev/null || true)"
if [ -z "$CLAUDE_BIN" ]; then
  cat >&2 <<'MSG'
claude (Claude Code CLI) 를 찾을 수 없습니다. 서비스를 실행할 이 사용자 계정으로 설치하세요. 예)
  curl -fsSL https://claude.ai/install.sh | bash
  # 또는
  npm i -g @anthropic-ai/claude-code
설치 뒤 새 셸을 열어 `claude --version` 이 되는지 확인하고 다시 실행해 주세요.
MSG
  exit 1
fi
check_linux_binary claude "$CLAUDE_BIN"

# ── 4. claude 로그인 ───────────────────────────────────────────────────────
# 환경 파일에 토큰(CLAUDE_CODE_OAUTH_TOKEN)이나 설정 디렉터리가 이미 있으면 서비스와 같은 조건으로 확인한다.
ENV_EXISTS=0
if sudo test -f "$ENV_FILE"; then ENV_EXISTS=1; fi
if [ "$ENV_EXISTS" = 1 ]; then
  SAVED_TOKEN="$(env_get CLAUDE_CODE_OAUTH_TOKEN)"
  SAVED_CONFIG_DIR="$(env_get CLAUDE_CONFIG_DIR)"
  if [ -n "$SAVED_TOKEN" ]; then export CLAUDE_CODE_OAUTH_TOKEN="$SAVED_TOKEN"; fi
  if [ -n "$SAVED_CONFIG_DIR" ]; then export CLAUDE_CONFIG_DIR="$SAVED_CONFIG_DIR"; fi
fi
AUTH_JSON="$(timeout 20 "$CLAUDE_BIN" auth status --json 2>/dev/null || true)"
LOGGED_IN="$(printf '%s' "$AUTH_JSON" | json_field loggedIn)"
AUTH_METHOD="$(printf '%s' "$AUTH_JSON" | json_field authMethod)"
if [ "$LOGGED_IN" != "true" ]; then
  cat >&2 <<MSG
claude 에 로그인되어 있지 않습니다 (claude auth status: ${LOGGED_IN:-확인 실패}).
먼저 같은 사용자(${USER_NAME})로 \`claude\` 를 실행해 /login 하거나,
\`claude setup-token\` 으로 토큰을 만들어 ${ENV_FILE} 의 CLAUDE_CODE_OAUTH_TOKEN 에 넣으세요.
(토큰을 넣으려면 먼저 설치를 끝내야 하므로: 지금은 /login 으로 로그인한 뒤 다시 실행하는 것이 가장 간단합니다.)
MSG
  exit 1
fi
echo "claude 로그인 확인: ${AUTH_METHOD:-ok} ($CLAUDE_BIN)"

# ── 5. 환경 파일 /etc/jaso/jaso.env ──────────────────────────────────────
sudo install -d -m 0755 -o root -g root "$ENV_DIR"
if [ "$ENV_EXISTS" = 1 ]; then
  echo "기존 설정 유지: $ENV_FILE"
  SAVED_PORT="$(env_get JASO_PORT)"
  if [ -n "$SAVED_PORT" ] && [ "$SAVED_PORT" != "$PORT" ]; then
    echo "  설정 파일의 포트(${SAVED_PORT})를 그대로 씁니다. 바꾸려면 sudo 로 $ENV_FILE 의 JASO_PORT 를 고친 뒤 다시 실행하세요."
    PORT="$SAVED_PORT"
  fi
  SAVED_BIN="$(env_get JASO_CLAUDE_BIN)"
  if [ -n "$SAVED_BIN" ] && [ ! -x "$SAVED_BIN" ]; then
    echo "  주의: 설정 파일의 JASO_CLAUDE_BIN(${SAVED_BIN}) 이 실행 파일이 아닙니다. 지금 찾은 경로는 $CLAUDE_BIN 입니다."
  fi
else
  ACCESS_KEY="$("$NODE_BIN" -e 'process.stdout.write(require("crypto").randomBytes(24).toString("base64url"))')"
  ENV_TMP="$TMP_DIR/jaso.env"
  (
    umask 077
    {
      echo "# jaso 서버 설정 — deploy/wsl/install.sh 가 $(date '+%Y-%m-%d %H:%M') 에 생성. root 만 읽습니다(0600)."
      echo "# 값을 바꾼 뒤에는 sudo systemctl restart jaso 로 반영하세요. 항목 설명은 README 의 환경 변수 표 참고."
      echo "JASO_HOST=127.0.0.1"
      echo "JASO_PORT=$PORT"
      echo "# 방문자가 입력하는 접속 키. 바꾸면(회전) 모든 방문자가 새 키를 다시 넣어야 합니다."
      echo "JASO_ACCESS_KEY=$ACCESS_KEY"
      echo "JASO_CLAUDE_BIN=$CLAUDE_BIN"
      echo "JASO_CONCURRENCY=1"
      if [ -n "${CLAUDE_CONFIG_DIR:-}" ]; then
        echo "CLAUDE_CONFIG_DIR=$CLAUDE_CONFIG_DIR"
      fi
      echo "# cloudflared 터널 뒤에서 운영하면 install-tunnel.sh 가 아래 줄을 1 로 켭니다(방문자 IP 를 CF-Connecting-IP 에서 읽음)."
      echo "# JASO_TRUST_PROXY=1"
      echo "# claude /login 대신 장기 토큰으로 인증하려면 \`claude setup-token\` 결과를 아래에 넣으세요."
      echo "# CLAUDE_CODE_OAUTH_TOKEN="
    } > "$ENV_TMP"
  )
  sudo install -m 0600 -o root -g root "$ENV_TMP" "$ENV_FILE"
  echo "설정 파일 생성: $ENV_FILE (접속 키 포함, root 전용)"
fi

# ── 6. 유닛 렌더링 ─────────────────────────────────────────────────────────
check_unit_safe "저장소 경로" "$DIR"
check_unit_safe "홈 디렉터리" "$HOME_DIR"
check_unit_safe "node 경로" "$NODE_BIN"
check_unit_safe "claude 경로" "$CLAUDE_BIN"
# 서비스의 PATH: claude 와 node 가 있는 디렉터리를 앞에 둔다(npm 으로 설치한 claude 는 PATH 의 node 를 찾는다).
SERVICE_PATH="$(dirname "$CLAUDE_BIN"):$(dirname "$NODE_BIN"):/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"
SERVICE_PATH="$(printf '%s' "$SERVICE_PATH" | tr ':' '\n' | awk '!seen[$0]++' | paste -sd: -)"
UNIT_TMP="$TMP_DIR/jaso.service"
sed -e "s#__USER__#$(unit_escape "$USER_NAME")#g" \
    -e "s#__HOME__#$(unit_escape "$HOME_DIR")#g" \
    -e "s#__DIR__#$(unit_escape "$DIR")#g" \
    -e "s#__NODE__#$(unit_escape "$NODE_BIN")#g" \
    -e "s#__PATH__#$(unit_escape "$SERVICE_PATH")#g" \
    "$DIR/deploy/wsl/jaso.service" > "$UNIT_TMP"
if grep -q '__[A-Z]*__' "$UNIT_TMP"; then
  echo "유닛 템플릿 치환이 끝나지 않았습니다. deploy/wsl/jaso.service 를 확인하세요." >&2
  grep -n '__[A-Z]*__' "$UNIT_TMP" >&2
  exit 1
fi
sudo install -m 0644 -o root -g root "$UNIT_TMP" "$UNIT_FILE"
sudo systemctl daemon-reload
sudo systemctl enable -q jaso.service
sudo systemctl restart jaso.service
echo "서비스 등록: $UNIT_FILE (사용자 ${USER_NAME}, 포트 ${PORT})"

# ── 7. 기동 확인 ───────────────────────────────────────────────────────────
# 서버는 시작할 때 claude 로그인 점검(실제 호출 1회)을 마친 뒤 포트를 열므로 수십 초가 걸릴 수 있다.
HEALTH_URL="http://127.0.0.1:${PORT}/api/health"
echo "기동 대기 중 (최대 ${HEALTH_WAIT_SEC}초, 시작 시 Claude 로그인 점검 때문에 1~2분 걸릴 수 있습니다)…"
HEALTH=""
i=0
while [ "$i" -lt "$HEALTH_WAIT_SEC" ]; do
  if HEALTH="$(curl -fsS --max-time 3 "$HEALTH_URL" 2>/dev/null)"; then break; fi
  HEALTH=""
  # 반복해서 죽고 있으면(재시작 횟수 증가) 더 기다리지 않는다.
  RESTARTS="$(systemctl show -p NRestarts --value jaso.service 2>/dev/null || echo 0)"
  if [ "${RESTARTS:-0}" -gt 0 ] || [ "$(systemctl is-active jaso.service 2>/dev/null || true)" = "failed" ]; then
    break
  fi
  sleep 1
  i=$((i + 1))
done
if [ -z "$HEALTH" ]; then
  echo "서버가 응답하지 않습니다 ($HEALTH_URL). 최근 로그:" >&2
  sudo journalctl -u jaso.service -n 30 --no-pager -o cat >&2 || true
  echo "자세히: journalctl -u jaso -f   상태: systemctl status jaso" >&2
  exit 1
fi

LOGIN_OK="$(printf '%s' "$HEALTH" | json_field login.ok)"
LOGIN_DETAIL="$(printf '%s' "$HEALTH" | json_field login.detail)"
AUTH_MODE="$(printf '%s' "$HEALTH" | json_field auth)"
USAGE_STATUS="$(printf '%s' "$HEALTH" | json_field usageWindow.status)"
case "$LOGIN_OK" in
  true) LOGIN_TEXT="정상" ;;
  false) LOGIN_TEXT="실패 — ${LOGIN_DETAIL:-원인 미상}. 서비스 사용자로 claude /login 뒤 sudo systemctl restart jaso" ;;
  *) LOGIN_TEXT="미확인 — ${LOGIN_DETAIL:-서버 로그를 확인하세요}" ;;
esac
echo
echo "서버 기동 확인: $HEALTH_URL"
echo "  Claude 로그인: $LOGIN_TEXT"
echo "  인증: $([ "$AUTH_MODE" = key ] && echo '접속 키 필요' || echo '열림(키 없음, JASO_ALLOW_ANON)')"
if [ -n "$USAGE_STATUS" ]; then echo "  구독 사용량 창: $USAGE_STATUS"; fi
ACCESS_KEY="$(env_get JASO_ACCESS_KEY)"
echo
echo "접속 키 (방문자에게 전달, 다시 보려면 bash deploy/wsl/install.sh --print-key):"
echo "  ${ACCESS_KEY:-(설정 파일에 없음)}"
echo
echo "로컬 확인: http://localhost:${PORT}/jaso/   (Windows 브라우저에서도 같은 주소)"
echo "로그: journalctl -u jaso -f   재시작: sudo systemctl restart jaso   중지: sudo systemctl disable --now jaso"
echo
echo "다음 단계:"
echo "  1) 외부 공개: bash deploy/wsl/install-tunnel.sh   (cloudflared 터널, 또는 처음부터 --tunnel 옵션)"
printf '%s\n' '  2) WSL 유지: Windows PowerShell 에서 powershell -ExecutionPolicy Bypass -File deploy\wsl\register-keepalive.ps1'
echo "  3) 방문자에게 주소와 접속 키를 전달. 키 회전은 README 의 '운영' 항목 참고."

if [ "$WITH_TUNNEL" = 1 ]; then
  echo
  rm -rf "$TMP_DIR"   # exec 하면 EXIT 트랩이 돌지 않으므로 먼저 치운다
  exec bash "$DIR/deploy/wsl/install-tunnel.sh" --port "$PORT"
fi
