# thread-snack-policy

이 저장소는 GitHub Pages로 배포되는 정적 사이트입니다.

| 경로 | 내용 |
| --- | --- |
| `/` (`index.html`, `privacy.html`, `data-deletion.html`) | thread-snack 앱의 정책 문서 (Meta App Review용) |
| `/jaso/` | **자소서 에이전트** — TIO 같은 자기소개서 완성 AI 에이전트 (개인용) |

---

## 자소서 에이전트 (`/jaso/`)

지원 정보와 문항을 넣으면 AI가 **경험을 인터뷰**하고, **초안을 쓰고**, **인사담당자 관점으로 첨삭**한 뒤, **글자수에 맞춰** 자기소개서를 완성하는 브라우저 앱입니다. 앱 자체는 브라우저에서 돌아가며, Claude를 호출하는 방식은 세 가지입니다.

| 실행 환경 | Claude 호출 방식 | 필요한 것 |
| --- | --- | --- |
| **claude.ai 아티팩트** (Team/Pro 등 구독) | 아티팩트 `sample` 기능으로 **보는 사람**의 claude.ai 구독 사용량을 씀 | claude.ai 로그인, 첫 호출 때 허용 |
| **운영자 구독 서버** (운영자 PC의 WSL2 + 터널) | 운영자 PC의 작은 Node 서버가 Claude Code CLI(`claude -p`)를 헤드리스로 실행해 **운영자**의 claude.ai 구독으로 호출 | 운영자: Node 18+, `claude` 로그인 · 방문자: 주소와 **접속 키** |
| GitHub Pages·로컬 정적 서버 | 브라우저에서 Anthropic API를 직접 호출 | Anthropic API 키(별도 과금) |

앱은 `window.claude`가 있으면 아티팩트 모드로 동작하고, 없으면 같은 서버의 `../api/health`를 한 번 확인해 jaso 서버가 응답하면 **운영자 구독 서버 모드**, 아니면(GitHub Pages·일반 정적 서버) API 키 모드로 전환합니다. 세 모드는 같은 코드(`jaso/src/`)를 쓰며 LLM 호출 계층만 다릅니다(`llm-sample.js` / `llm-remote.js` / `llm-sdk.js`).

**운영자 구독 서버 모드**는 운영자가 자기 PC(WSL2, systemd)에서 `jaso/server/server.mjs`를 상시 실행하는 방식입니다. 서버는 정적 파일을 서빙하고, 방문자의 요청마다 공식 Claude Code CLI를 `claude -p`(도구 없음, 세션 저장 없음, 설정 파일 무시)로 띄워 운영자의 claude.ai 구독으로 답을 받아 그대로 중계합니다. Anthropic API 키는 쓰지 않습니다. 방문자는 운영자에게 받은 **접속 키**를 설정에 넣어 인증하고, 외부 접속은 cloudflared 터널로 열어 둡니다. 서버는 프롬프트·응답을 저장하거나 로그에 남기지 않습니다(요청 로그에는 시각·IP·경로·상태·바이트 수만 남습니다).

### 흐름

1. **지원 정보** — 회사·직무·신입/경력, 문항(글자수·공백 기준·유형), 회사에 대해 아는 것·써 본 서비스·지원 계기, 블라인드 채용 여부. 채용 공고를 붙여 넣으면 문항·글자수·요구 역량을 자동 추출합니다. 자주 나오는 문항 템플릿과 기업별 예시 세트(삼성·현대차·LG·SK하이닉스·네이버·카카오·CJ·롯데·포스코·신한·코레일·공기업 NCS·스타트업)도 제공합니다.
2. **경험 인터뷰** — 에이전트가 문항에 맞춰 경험을 한 번에 하나씩 캐묻고(왜 묻는지·힌트 포함), 상황·과제·행동·결과·배운 점·키워드·연관 문항으로 된 **경험 카드**를 자동 저장합니다. 카드는 직접 추가·편집할 수도 있습니다. 중단하거나 새로고침해도 대화 히스토리가 남아 「이어서 진행」할 수 있습니다.
3. **작성·첨삭** — 문항마다 `초안 → 첨삭(6개 기준 100점 채점) → 수정 → 재첨삭 → 글자수 조정`을 자동으로 돌립니다. 완성 후에는 프리셋(더 간결하게, 결과 강조, 두괄식 강화, 더 자연스럽게, 직무 연결, 소제목 추가/제거)이나 자유 지시로 수정하고, 본문에서 문장을 드래그하면 **그 부분만** 고칩니다. 대안 버전 생성과 버전 전환도 됩니다.
4. **완성** — 전체 복사, TXT/Markdown 다운로드, 프로젝트 JSON 내보내기·가져오기, 자소서 기반 **면접 예상 질문**과 답변 전략 생성.

### 설계 포인트

- **사실 창작 금지** — 작성자는 경험 카드에 없는 수치·성과를 만들지 않고, 꼭 필요하면 `[확인: …]`으로 표시합니다. 완성 화면이 남은 확인 항목을 모아 보여 줍니다.
- **AI 티 제거** — 인사담당자가 지적하는 패턴("열정을 바탕으로", "다양한 프로젝트", 균일한 문장 길이, 수치 부재 등)을 작성·첨삭 프롬프트에 명시합니다.
- **글자수 제어** — 공백 포함/공백 제외/바이트(한글 2byte) 세 기준을 지원하고(줄바꿈은 1자), 목표 범위(제한의 90~100%, 작성 목표는 상한의 96%)를 벗어나면 별도 조정 단계를 돌립니다. 판정은 모델이 아니라 코드가 합니다.
- **블라인드 채용 대응** — 체크하면 인터뷰어는 학교명·가족·출신지·나이·성별을 묻지 않고, 작성자는 쓰지 않으며, 첨삭은 기재 시 필수 수정으로 잡습니다.
- **에이전트 루프** — 인터뷰는 `ask_user` / `save_experience` / `finish_interview` 도구를 쓰는 tool-use 루프이며, 히스토리는 append-only로 유지하고 thinking 블록을 그대로 되돌려 보냅니다(preserved thinking 호환).
- **모델** — 구독 모드(아티팩트·운영자 구독 서버)는 모델 등급(complex/default/quick)을 고르며 초안·수정은 `complex`, 인터뷰·첨삭·분석은 `default`로 실행합니다. 운영자 구독 서버는 등급을 CLI의 모델·노력(effort)으로 바꿔 보내며 기본값은 complex=`opus`/high, default=`sonnet`/medium, quick=`sonnet`/low(환경 변수로 조정)입니다. API 키 모드는 기본 `claude-opus-5-5`, 선택으로 `claude-sonnet-5-5`, `claude-fable-5-1`이고 안전 분류기 거절 시 서버 측 폴백(`fallbacks: "default"`)을 켭니다.
- **구독 모드의 차이** — 시스템 프롬프트와 도구 호출이 없으므로 지시를 프롬프트 앞에 붙이고, 인터뷰는 JSON 턴(저장할 카드·다음 질문·종료)으로 진행합니다. 운영자 구독 서버는 같은 프롬프트 합성을 쓰되 JSON 출력은 CLI의 `--json-schema`로 구조화합니다. 아티팩트에서는 파일 저장에 `downloads` 기능을 쓰고, 확인 창은 페이지 안의 대화상자로 대체합니다.

### 실행

**claude.ai 아티팩트(구독)** — 게시된 아티팩트 링크를 claude.ai에 로그인한 상태로 엽니다. 첫 Claude 호출 때 "이 아티팩트가 Claude를 사용하도록 허용" 확인이 뜹니다. 다시 게시하려면 아래처럼 페이지를 만들고 Claude Code의 Artifact 도구로 `jaso/dist/artifact.html`을 `src/*.js`와 함께 올리면 됩니다(`capabilities: { sample: {}, downloads: true }`).

```bash
npm run build:artifact   # jaso/dist/artifact.html 생성 (index.html 본문 + style.css 인라인)
```

**운영자 구독 서버(로컬에서 시험)** — Claude Code CLI(`claude`)가 설치되어 있고 구독 계정으로 로그인(`claude` 실행 후 `/login`)된 PC에서:

```bash
JASO_ALLOW_ANON=1 npm start      # http://127.0.0.1:8080/jaso/ — 접속 키 없이 localhost 시험용
JASO_ACCESS_KEY=비밀키 npm start   # 접속 키를 요구하는 실제 동작 (키는 설정에 입력)
```

서버는 시작할 때 `claude auth status`와 짧은 실제 호출 1회로 로그인을 점검한 뒤 포트를 엽니다(`JASO_LOGIN_PROBE=0`으로 끌 수 있음). 상시 운영과 외부 공개는 아래 WSL2 절을 보세요.

**GitHub Pages·로컬(API 키)** — `https://<user>.github.io/<repo>/jaso/`에서 바로 열립니다. 로컬에서는 모듈 스크립트 때문에 정적 서버가 필요합니다.

```bash
npm run serve        # http://localhost:8080/jaso/ (정적 서버만, API 키 모드)
```

첫 화면의 **설정**에서 Anthropic API 키를 입력하세요. 키는 이 브라우저의 `sessionStorage`(기본) 또는 체크 시 `localStorage`에만 저장되며 `api.anthropic.com`으로만 전송됩니다. 공용 PC에서는 저장 옵션을 켜지 마세요. 프록시를 쓰려면 설정의 Base URL을 바꾸면 됩니다.

### WSL2에서 외부 공개 서버로 운영하기 (운영자 구독 모드)

운영자의 Windows PC에서 WSL2 안에 jaso 서버를 systemd 서비스로 올리고, cloudflared 터널로 외부에 공개하는 구성입니다. 스크립트와 유닛은 `deploy/wsl/`에 있습니다.

**준비물**

- Windows 10/11 + WSL2(Ubuntu·Debian 계열), WSL에서 systemd 사용.
- WSL 안에 Node.js 18 이상.
- WSL 안에 Claude Code CLI(`curl -fsSL https://claude.ai/install.sh | bash` 또는 `npm i -g @anthropic-ai/claude-code`)를 **서비스를 돌릴 사용자 계정으로** 설치하고, `claude`를 실행해 `/login`으로 claude.ai 구독(Team 등) 계정에 로그인. 토큰 방식도 됩니다: `claude setup-token`으로 장기 토큰을 만든 뒤 `CLAUDE_CODE_OAUTH_TOKEN='sk-ant-oat01-…' bash deploy/wsl/install.sh`처럼 넘기면 `/etc/jaso/jaso.env`에 저장됩니다.

**설치 3단계** (모두 WSL 셸에서, 저장소 루트에서 실행)

1. systemd 켜기 — `/etc/wsl.conf`에 `[boot]` 아래 `systemd=true`를 넣고 Windows에서 `wsl --shutdown` 후 다시 엽니다.
2. 서버 설치 — `bash deploy/wsl/install.sh` (포트를 바꾸려면 `--port 8090`). 스크립트는 systemd·Node 버전·`claude`·로그인 상태를 차례로 확인한 뒤, 접속 키를 새로 만들어 `/etc/jaso/jaso.env`(root 전용 0600)에 쓰고, `jaso.service`를 등록·시작하고, `/api/health`가 응답하면 로그인 상태 요약과 **접속 키**를 출력합니다. 이미 설정 파일이 있으면 덮어쓰지 않고(`기존 설정 유지`) 유닛만 다시 렌더링합니다. 키만 다시 보려면 `bash deploy/wsl/install.sh --print-key`.
3. 외부 공개 — `bash deploy/wsl/install-tunnel.sh` (2단계에서 `--tunnel`을 붙이면 이어서 실행됩니다). `cloudflared`가 없으면 설치하고(apt 저장소, 실패 시 GitHub 릴리스 `.deb`), `jaso-tunnel.service`를 등록하고, `/etc/jaso/jaso.env`에 `JASO_TRUST_PROXY=1`을 켜 jaso를 재시작한 뒤, 터널이 받은 `https://….trycloudflare.com` 주소를 출력합니다.

**터널** — 기본은 Cloudflare **빠른 터널(quick tunnel)**로, 계정 없이 바로 쓸 수 있지만 주소가 터널(또는 PC/WSL)이 다시 시작될 때마다 바뀝니다(현재 주소: `bash deploy/wsl/install-tunnel.sh --url`). 고정 주소가 필요하면 Cloudflare에 등록된 도메인으로 **이름 있는 터널**을 만듭니다 — `cloudflared tunnel login` → `cloudflared tunnel create jaso` → `cloudflared tunnel route dns jaso <호스트명>` → `/etc/cloudflared/config.yml`에 `ingress: - hostname: <호스트명>  service: http://127.0.0.1:8080` → `sudo cloudflared service install`. 정확한 명령은 `install-tunnel.sh`가 마지막에 출력합니다. 서버는 어느 경우에도 `127.0.0.1`에만 바인딩됩니다.

**WSL 살려 두기** — WSL VM은 유휴 상태에서 꺼질 수 있습니다. Windows PowerShell에서 `powershell -ExecutionPolicy Bypass -File deploy\wsl\register-keepalive.ps1`를 한 번 실행하면 로그온할 때마다 창 없는 `wsl.exe` 프로세스 하나를 유지해 VM과 함께 서버·터널을 살려 둡니다(화면 잠금은 괜찮고, 로그아웃이나 PC 종료 시에는 멈춥니다). 배포판 이름이 Ubuntu가 아니면 `wsl-keepalive.vbs`의 `-d` 값을 바꾸세요.

**방문자 사용법** — 운영자가 전달한 주소(`https://….trycloudflare.com/jaso/`)를 열면 상단 배지가 `운영자 구독`으로 표시되고, **설정**에서 운영자에게 받은 **접속 키**를 넣으면 바로 쓸 수 있습니다(키는 그 브라우저에만 저장). 사이드바에는 호출 수·최근 등급과 운영자 구독의 **사용량 창** 상태가 보입니다. 키가 틀리면 "접속 키가 올바르지 않습니다.", 운영자 로그인이 끊기면 "운영자의 Claude 로그인이 만료되었거나 설정되지 않았습니다.", 구독 한도에 걸리면 "운영자 Claude 구독의 사용량 한도에 걸렸습니다. {시각} 이후 다시 시도해 주세요.", 동시에 처리할 수 있는 요청(기본 1개 + 대기 6개)이 넘치면 "지금 다른 요청을 처리하고 있습니다." 안내가 뜹니다.

**운영**

```bash
journalctl -u jaso -f                 # 서버 로그 (내용은 남지 않고 시각·IP·경로·상태·바이트만)
systemctl status jaso jaso-tunnel     # 상태
sudo systemctl restart jaso           # 설정(/etc/jaso/jaso.env) 변경·코드 갱신(git pull) 후 재시작
claude auth status                    # 서비스 사용자로 실행 — 로그인이 끊겼으면 `claude` → /login 후 jaso 재시작
curl -s http://127.0.0.1:8080/api/health   # login.ok, usageWindow, queue 확인
bash deploy/wsl/install-tunnel.sh --url    # 현재 터널 주소
sudo systemctl disable --now jaso jaso-tunnel   # 중지
```

접속 키 회전(모든 방문자가 새 키를 다시 넣어야 합니다):

```bash
NEW=$(node -e 'process.stdout.write(require("crypto").randomBytes(24).toString("base64url"))')
sudo sed -i "s/^JASO_ACCESS_KEY=.*/JASO_ACCESS_KEY=$NEW/" /etc/jaso/jaso.env && sudo systemctl restart jaso && echo "$NEW"
```

**환경 변수** (`/etc/jaso/jaso.env` 또는 `npm start` 앞에 지정, 모두 선택)

| 변수 | 기본값 | 의미 |
| --- | --- | --- |
| `JASO_HOST` / `JASO_PORT` | `127.0.0.1` / `8080` | 바인딩 주소·포트 |
| `JASO_ACCESS_KEY` | (없음) | 방문자 접속 키. 비어 있고 `JASO_ALLOW_ANON`이 `1`이 아니면 서버가 안내 메시지와 함께 종료(코드 2) |
| `JASO_ALLOW_ANON` | `0` | `1`이면 키 없이 허용(localhost 시험용) |
| `JASO_CLAUDE_BIN` | `claude` | CLI 경로. install.sh가 절대 경로로 채움 |
| `JASO_ROOT` | 저장소 루트 | 정적 파일 루트 |
| `JASO_CONCURRENCY` / `JASO_MAX_QUEUE` | `1` / `6` | 동시에 띄울 CLI 수 / 그 이상 대기열 길이(넘치면 503 `busy`) |
| `JASO_RATE_LIMIT` / `JASO_AUTH_FAIL_LIMIT` | `40/600` / `10/600` | IP별 요청 수·인증 실패 수 제한(`횟수/초`) |
| `JASO_MAX_INPUT_BYTES` / `JASO_MAX_BODY_BYTES` | `300000` / `1048576` | 프롬프트·요청 본문 상한(넘으면 413) |
| `JASO_TRUST_PROXY` | `0` | `1`이면 방문자 IP를 `CF-Connecting-IP`(없으면 `X-Forwarded-For`)에서 읽음 — 터널 뒤에서 켬 |
| `JASO_FIRST_OUTPUT_TIMEOUT_MS` / `JASO_TOTAL_TIMEOUT_MS` | `120000` / `600000` | 첫 출력·전체 시간 제한(넘으면 504 `timeout`) |
| `JASO_MODEL_{COMPLEX,DEFAULT,QUICK}` / `JASO_EFFORT_{…}` | `opus`/`high`, `sonnet`/`medium`, `sonnet`/`low` | 등급별 모델·노력 |
| `JASO_FALLBACK_MODEL` | `sonnet` | `--fallback-model`(선택한 모델과 다를 때만 전달, 빈 문자열이면 끔) |
| `JASO_WORK_DIR` | `<tmp>/jaso-work` | CLI 자식 프로세스의 빈 작업 폴더 |
| `JASO_LOGIN_PROBE` | `1` | 시작 시 실제 호출 1회로 로그인 검증(`0`이면 끔) |
| `JASO_ALLOW_API_KEY` | `0` | `1`이 아니면 자식 환경에서 `ANTHROPIC_API_KEY` 등을 제거(구독만 사용) |
| `JASO_LOG_LEVEL` | `info` | 요청마다 한 줄 로그. 프롬프트·응답 내용은 어떤 레벨에서도 남기지 않음 |
| `JASO_CHILD_ENV_PASSTHROUGH` | (없음) | 자식 `claude` 프로세스에 추가로 넘길 환경 변수 이름(쉼표 구분, 예: `HTTPS_PROXY,NO_PROXY`). 기본은 HOME·PATH 등 최소만 전달하므로 사내 프록시 뒤에서는 여기에 적어야 함 |
| `CLAUDE_CODE_OAUTH_TOKEN` / `CLAUDE_CONFIG_DIR` | (없음) | `/login` 대신 `claude setup-token` 토큰으로 인증(설치 시 `CLAUDE_CODE_OAUTH_TOKEN=… bash deploy/wsl/install.sh` 로 넘기면 저장됨) / `~/.claude` 대신 쓸 설정 폴더 |

> **주의 — 반드시 읽어 주세요**
>
> - **구독 좌석은 개인용입니다.** 운영자 구독 서버 모드는 운영자 한 사람의 Team(또는 Pro/Max) 좌석으로 모든 방문자의 요청을 처리합니다. 그 좌석의 5시간·주간 사용량 창을 접속 키를 가진 모두가 **함께** 소모하므로, 한도에 걸리면 운영자 본인도 못 쓰게 됩니다. 접속 키는 가족·친구 등 믿을 수 있는 소수에게만 주세요.
> - **약관.** Anthropic의 이용 약관은 구독 좌석을 1인 사용으로 봅니다. 접속 키를 불특정 다수에게 공개하거나 서비스처럼 운영하면 약관 위반이 될 수 있습니다. 공개 서비스가 필요하면 API 키 모드(건당 과금)를 쓰세요.
> - **운영자의 서버는 내용을 봅니다.** 방문자가 입력한 지원 정보·경험·자소서는 운영자의 PC를 거쳐 Claude로 전달됩니다. 서버는 저장하지 않고(`--no-session-persistence`, 로그에도 내용 없음) 통과만 시키지만, 방문자는 이 점을 알고 써야 합니다.
> - **조직(Team/Enterprise) 관리자의 텔레메트리 설정이 그대로 적용됩니다.** 서버가 실행하는 `claude` CLI는 운영자 계정의 **서버 관리 설정**(claude.ai 관리자 설정 > Claude Code)을 받아서 따릅니다. 관리자가 OpenTelemetry 수집을 켜 두었으면 호출 수·토큰·비용·`user.email` 같은 메타데이터가 조직 수집기로 전송되고, 관리자가 `OTEL_LOG_USER_PROMPTS`·`OTEL_LOG_ASSISTANT_RESPONSES`·`OTEL_LOG_TOOL_DETAILS`·`OTEL_LOG_TOOL_CONTENT`·`OTEL_LOG_RAW_API_BODIES` 토글까지 켰다면 **방문자의 프롬프트·답변 본문도 포함**될 수 있습니다. 관리 설정은 환경 변수보다 우선하므로 이 서버가 막을 수 없습니다(기본값은 모두 꺼짐). 헤드리스(`claude -p`) 실행에서는 승인 대화상자 없이 그대로 적용됩니다. 운영 전에 `claude doctor`의 `Managed settings (remote)` 줄과 `~/.claude/remote-settings.json`의 `env` 블록에서 `OTEL_LOG_*` 항목을 확인하고(설정은 매시간 갱신되므로 주기적으로), 조직 관리자에게도 물어본 뒤 방문자에게 알리세요.
> - **빠른 터널은 Cloudflare의 무료 편의 기능**이라 주소가 바뀌고 가용성이 보장되지 않습니다. 고정 주소가 필요하면 이름 있는 터널을 쓰세요.
> - **서버 없이 쓰는 길도 있습니다.** 자기 claude.ai 계정이 있는 사람은 위의 claude.ai 아티팩트 링크를 열면 **자기 구독**으로 같은 앱을 쓸 수 있습니다. 운영자 서버는 claude.ai 계정이 없는 사람을 위한 선택지입니다.

### 개발

```bash
npm install
npm test             # 단위 테스트 (node:test) — 앱 로직과 서버(가짜 claude CLI 사용, 실제 호출 없음)
npm run e2e          # Playwright E2E 3종 — API 키 모드(모의 Anthropic API), 아티팩트 모드(가짜 window.claude), 운영자 구독 서버 모드(가짜 claude CLI). 스크린샷은 .playwright/ (처음 실행 시 Chromium을 내려받습니다)
npm start            # 운영자 구독 서버 로컬 실행 (JASO_ALLOW_ANON=1 을 앞에 붙이면 키 없이)
npm run build:artifact  # claude.ai 아티팩트용 페이지 생성
npm run vendor       # jaso/vendor/anthropic-sdk.mjs 재생성 (@anthropic-ai/sdk 브라우저 번들)
```

`jaso/vendor/anthropic-sdk.mjs`는 공식 `@anthropic-ai/sdk`를 esbuild로 브라우저용 ESM 번들한 파일이며, `index.html`의 import map이 `@anthropic-ai/sdk`를 이 파일로 연결합니다. 서버는 런타임 의존성이 없습니다(Node 내장 모듈만 사용).

```
jaso/
├─ index.html          # 앱 셸(API 키·운영자 구독 서버 모드 진입점), import map, 대화상자
├─ dist/artifact.html  # claude.ai 아티팩트용 본문(빌드 산출물)
├─ style.css
├─ vendor/anthropic-sdk.mjs   # API 키 모드에서만 동적 로드
├─ server/
│  ├─ server.mjs       # 운영자 구독 서버: 정적 서빙, /api/health, /api/sample(SSE 스트리밍), claude -p 자식 프로세스 관리
│  └─ lib.mjs          # 순수 헬퍼: 설정 파싱, 프롬프트 평탄화, stream-json 파서, 오류 분류, 인증, 속도 제한, 정적 경로 검사
└─ src/
   ├─ app.js           # UI 상태·렌더링·이벤트, 실행 환경 감지
   ├─ agent.js         # 인터뷰 상태 관리, 작성/첨삭/수정 파이프라인, 공고 분석, 면접 질문
   ├─ llm-sample.js    # 구독 모드 제공자(sample: 프롬프트 합성, JSON 턴 인터뷰) — 아티팩트·서버 공용
   ├─ llm-remote.js    # 운영자 구독 서버 클라이언트(/api/sample 호출, SSE 파싱, 접속 키)
   ├─ llm-sdk.js       # Anthropic SDK 제공자(tool use 인터뷰 루프, 구조화 출력, 폴백)
   ├─ interview.js / experiences.js / errors.js   # 공통 헬퍼
   ├─ prompts.js       # 시스템 프롬프트, 도구/출력 스키마, 메시지 빌더 (한국어)
   ├─ api.js           # 모델 목록, 오류 문구, 비용 추정
   ├─ text.js          # 글자수 계산·판정, 스키마 검증 등 순수 함수
   ├─ presets.js       # 문항 템플릿·기업별 예시 세트
   └─ storage.js       # localStorage/sessionStorage (API 키·접속 키 포함)
deploy/wsl/
├─ install.sh / jaso.service               # WSL2 systemd 서비스 설치(운영자 구독 모드)
├─ install-tunnel.sh / jaso-tunnel.service # cloudflared 터널
└─ register-keepalive.ps1 / wsl-keepalive.vbs   # Windows 쪽 WSL 유지
```

### 비용·주의

- 문항 하나를 완성하는 데 보통 Claude 호출 3~7회(초안 1, 첨삭 1~3, 수정 0~2, 글자수 조정 0~2)가 듭니다. 아티팩트 모드에서는 보는 사람의 claude.ai 사용량이, 운영자 구독 서버 모드에서는 **운영자**의 사용량이 쓰이고(한도에 걸리면 안내된 시각 이후 재시도), API 키 모드에서는 사이드바에 토큰·추정 비용이 누적 표시됩니다.
- 기업별 문항 프리셋은 공개 자료를 정리한 **참고용**입니다. 문항 문구·글자수·공백 기준은 채용 회차마다 바뀌므로 반드시 실제 공고를 확인하세요.
- AI가 만든 초안을 그대로 제출하기보다, 인터뷰에서 말한 자기 경험이 정확히 반영됐는지 확인하고 표현을 자기 말로 다듬는 것을 권합니다.
