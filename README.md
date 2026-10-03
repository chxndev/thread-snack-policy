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
| **운영자 구독 서버** (운영자 PC의 WSL2 + Tailscale Funnel 또는 터널) | 운영자 PC의 작은 Node 서버가 Claude Code CLI(`claude -p`)를 헤드리스로 실행해 **운영자**의 claude.ai 구독으로 호출 | 운영자: Node 18+, `claude` 로그인 · 방문자: 주소와 **접속 키** |
| GitHub Pages·로컬 정적 서버 | 브라우저에서 Anthropic API를 직접 호출 | Anthropic API 키(별도 과금) |

앱은 `window.claude`가 있으면 아티팩트 모드로 동작하고, 없으면 같은 서버의 `../api/health`를 한 번 확인해 jaso 서버가 응답하면 **운영자 구독 서버 모드**, 아니면(GitHub Pages·일반 정적 서버) API 키 모드로 전환합니다. 세 모드는 같은 코드(`jaso/src/`)를 쓰며 LLM 호출 계층만 다릅니다(`llm-sample.js` / `llm-remote.js` / `llm-sdk.js`).

**운영자 구독 서버 모드**는 운영자가 자기 PC(WSL2, systemd)에서 `jaso/server/server.mjs`를 상시 실행하는 방식입니다. 서버는 정적 파일을 서빙하고, 방문자의 요청마다 공식 Claude Code CLI를 `claude -p`(도구 없음, 세션 저장 없음, 설정 파일 무시)로 띄워 운영자의 claude.ai 구독으로 답을 받아 그대로 중계합니다. Anthropic API 키는 쓰지 않습니다. 방문자는 운영자에게 받은 **접속 키**를 설정에 넣어 인증하고, 외부 접속은 **Tailscale Funnel**(무료 고정 주소, 권장)이나 cloudflared 터널로 열어 둡니다. 서버는 프롬프트·응답을 저장하거나 로그에 남기지 않습니다(요청 로그에는 시각·IP·경로·상태·바이트 수만 남습니다). 같은 서버에서 **폰과 PC를 오가며 이어 쓰기**(브라우저에서 암호화한 사본만 서버에 보관)와 **폰 홈 화면 설치**(PWA)도 되고, 조직 관리자가 프롬프트·답변 본문 수집 텔레메트리를 켜 두었으면 **텔레메트리 가드**가 Claude 호출을 막습니다.

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

운영자의 Windows PC에서 WSL2 안에 jaso 서버를 systemd 서비스로 올리고, 무료 **Tailscale Funnel**(또는 cloudflared 터널)로 외부에 공개하는 구성입니다. 스크립트와 유닛은 `deploy/wsl/`에 있습니다.

**준비물**

- Windows 10/11 + WSL2(Ubuntu·Debian 계열), WSL에서 systemd 사용.
- WSL 안에 Node.js 18 이상.
- WSL 안에 Claude Code CLI(`curl -fsSL https://claude.ai/install.sh | bash` 또는 `npm i -g @anthropic-ai/claude-code`)를 **서비스를 돌릴 사용자 계정으로** 설치하고, `claude`를 실행해 `/login`으로 claude.ai 구독(Team 등) 계정에 로그인. 토큰 방식도 됩니다: `claude setup-token`으로 장기 토큰을 만든 뒤 `CLAUDE_CODE_OAUTH_TOKEN='sk-ant-oat01-…' bash deploy/wsl/install.sh`처럼 넘기면 `/etc/jaso/jaso.env`에 저장됩니다.

**설치 3단계** (모두 WSL 셸에서, 저장소 루트에서 실행)

1. systemd 켜기 — `/etc/wsl.conf`에 `[boot]` 아래 `systemd=true`를 넣고 Windows에서 `wsl --shutdown` 후 다시 엽니다.
2. 서버 설치 — `bash deploy/wsl/install.sh` (포트를 바꾸려면 `--port 8090`). 스크립트는 systemd·Node 버전·`claude`·로그인 상태를 차례로 확인한 뒤, 접속 키를 새로 만들어 `/etc/jaso/jaso.env`(root 전용 0600)에 쓰고, 기기 간 동기화용 폴더 `/var/lib/jaso/sync`(서비스 사용자 전용 0700)를 만들어 `JASO_DATA_DIR`로 기록하고, `jaso.service`를 등록·시작합니다. `/api/health`가 응답하면 로그인 상태·조직 텔레메트리 상태 요약과 **접속 키**를 출력합니다. 이미 설정 파일이 있으면 덮어쓰지 않고(`기존 설정 유지`) 유닛만 다시 렌더링합니다. 키만 다시 보려면 `bash deploy/wsl/install.sh --print-key`.
3. 외부 공개 — 아래 「무료로 외부 공개하기」의 **(1) Tailscale Funnel**을 권장합니다: `bash deploy/wsl/install-funnel.sh` (2단계에서 `--funnel`을 붙이면 이어서 실행됩니다). 계정 없이 당장 시험만 하려면 (2) 빠른 터널 `bash deploy/wsl/install-tunnel.sh` (`--tunnel`).

#### 무료로 외부 공개하기

| 방법 | 비용 | 필요한 계정 | 주소 | 폰 홈 화면 설치 |
| --- | --- | --- | --- | --- |
| **(1) Tailscale Funnel (권장)** | 무료 (Personal 요금제에 포함) | Tailscale 계정 (Google·Microsoft·GitHub·Apple 계정 등으로 가입) | `https://jaso.<tailnet>.ts.net/` — **고정** | 적합 |
| (2) Cloudflare 빠른 터널 | 무료 | 없음 | `https://….trycloudflare.com` — 다시 시작할 때마다 **바뀜** | 주소가 바뀌면 다시 추가해야 함 |
| (3) Cloudflare 이름 있는 터널 | 도메인 비용(유료) | Cloudflare 계정 + 등록된 도메인 | 내 도메인 — 고정 | 적합 |

어느 방법이든 서버는 `127.0.0.1`에만 바인딩되고, 스크립트가 `/etc/jaso/jaso.env`에 `JASO_TRUST_PROXY=1`을 켜서 방문자 IP를 프록시 헤더에서 읽게 합니다. 방문자는 아무것도 설치하거나 가입할 필요가 없습니다.

##### (1) Tailscale Funnel — 고정 주소, 무료, 도메인 불필요 (권장)

Tailscale은 내 기기들을 하나의 사설 네트워크(**tailnet**)로 묶어 주는 서비스이고, **Funnel**은 그중 한 기기의 포트 하나를 인터넷에 HTTPS로 공개하는 기능입니다. 주소는 `https://<기기 이름>.<tailnet 이름>.ts.net/` 꼴로 한 번 정해지면 바뀌지 않고, 무료 Personal 요금제에 포함됩니다. 도메인을 살 필요도, Cloudflare를 쓸 필요도 없습니다. Tailscale을 처음 써 봐도 아래 순서대로 하면 됩니다. 처음 한 번은 **대략 10분**(설치 1~2분, 가입·로그인 2~3분, 관리 콘솔 설정 1~2분, 첫 HTTPS 인증서 발급 1~2분)이 걸리고, 그다음부터는 할 일이 없습니다.

1. **스크립트 실행** — WSL 셸의 저장소 루트에서 `bash deploy/wsl/install-funnel.sh` (처음 설치라면 `bash deploy/wsl/install.sh --funnel`로 한 번에). Tailscale이 없으면 공식 설치 스크립트(`curl -fsSL https://tailscale.com/install.sh | sh`)로 설치하고 `tailscaled` 서비스를 켭니다. 중간에 sudo 비밀번호를 물으면 WSL 사용자 비밀번호를 넣습니다.
2. **브라우저에서 로그인 (처음 한 번)** — 터미널에 `https://login.tailscale.com/a/…` 주소가 나오면 **Windows 브라우저**에서 엽니다(Windows Terminal에서는 Ctrl+클릭, 아니면 복사해 주소창에 붙여 넣기). Google·Microsoft·GitHub·Apple 계정 등으로 로그인하면, 처음에는 이때 무료 계정과 내 tailnet이 만들어집니다. 이 기기(`jaso`)를 연결하는 버튼(Connect)이 보이면 누르세요. 터미널은 로그인이 끝날 때까지 최대 10분 기다렸다가 저절로 다음 단계로 넘어갑니다. 기기 이름을 바꾸려면 `--hostname 이름`(이 스크립트가 처음 로그인시킬 때만 반영).
3. **관리 콘솔에서 두 가지 켜기 (처음 한 번만)** — Funnel에는 tailnet의 HTTPS 인증서와 `funnel` 속성이 필요합니다. Tailscale이 `To enable, visit: https://login.tailscale.com/…` 같은 승인 주소를 보여 주고 기다리면 그 주소를 Windows 브라우저에서 열어 허용(Enable)하면 됩니다(터미널은 최대 10분 기다렸다가 이어서 진행). 오류 문구와 함께 멈추면 스크립트가 Tailscale의 문구를 그대로 보여 주고 아래 두 가지를 어디서 켜는지 안내합니다. 각각 한 번씩 켠 뒤 스크립트를 다시 실행하세요.
   - `Funnel not available; HTTPS must be enabled. See https://tailscale.com/s/https.` → [관리 콘솔 DNS 페이지](https://login.tailscale.com/admin/dns)의 **HTTPS Certificates**에서 **Enable HTTPS**를 누릅니다(같은 페이지의 MagicDNS가 꺼져 있으면 먼저 켭니다).
   - `Funnel not available; "funnel" node attribute not set. See https://tailscale.com/s/no-funnel.` → [접근 제어(Access controls)](https://login.tailscale.com/admin/acls)의 정책 파일에 `"nodeAttrs": [{ "target": ["autogroup:member"], "attr": ["funnel"] }]`가 있어야 합니다. 없으면 넣고 저장합니다.

성공하면 스크립트가 `sudo tailscale funnel --bg <포트>`로 공개를 켜고, `JASO_TRUST_PROXY=1`을 설정해 jaso를 재시작하고, 공개 주소의 `/api/health`를 한 번 불러 본 다음(첫 HTTPS 인증서 발급도 이때 시작됩니다) **`https://jaso.<tailnet>.ts.net/jaso/` 주소와 접속 키**를 출력합니다. 이 주소는 PC·WSL을 다시 시작해도 그대로입니다(`--bg`로 켠 Funnel 설정은 저장됩니다). 주소 다시 보기 `bash deploy/wsl/install-funnel.sh --url`, 공개 중지 `bash deploy/wsl/install-funnel.sh --off`(`sudo tailscale funnel reset` — 이 기기의 serve/funnel 설정을 모두 지웁니다. 다시 켜면 같은 주소). 주소는 HTTPS 인증서의 공개 기록(Certificate Transparency)에 남아 누구나 찾을 수 있으므로, 주소를 비밀로 여기지 말고 **접속 키**로 보호하세요.

##### (2) Cloudflare 빠른 터널 — 계정 없음, 주소 변동

`bash deploy/wsl/install-tunnel.sh` (설치 2단계에서 `--tunnel`을 붙이면 이어서 실행됩니다). `cloudflared`가 없으면 설치하고(apt 저장소, 실패 시 GitHub 릴리스 `.deb`), `jaso-tunnel.service`를 등록하고, `JASO_TRUST_PROXY=1`을 켜 jaso를 재시작한 뒤, 터널이 받은 `https://….trycloudflare.com` 주소를 출력합니다. 계정 없이 바로 쓸 수 있지만 주소가 터널(또는 PC/WSL)이 다시 시작될 때마다 바뀌므로, 그때마다 방문자에게 새 주소를 알려야 하고 폰 홈 화면 아이콘도 다시 추가해야 합니다(현재 주소: `bash deploy/wsl/install-tunnel.sh --url`). 잠깐 시험할 때 알맞습니다.

##### (3) Cloudflare 이름 있는 터널 — 도메인 필요(유료)

Cloudflare에 등록된 본인 도메인이 있으면 고정 호스트명으로 공개할 수 있습니다 — `cloudflared tunnel login` → `cloudflared tunnel create jaso` → `cloudflared tunnel route dns jaso <호스트명>` → `/etc/cloudflared/config.yml`에 `ingress: - hostname: <호스트명>  service: http://127.0.0.1:8080` → `sudo cloudflared service install`. 정확한 명령은 `install-tunnel.sh`가 마지막에 출력합니다. 빠른 터널을 끄고(`sudo systemctl disable --now jaso-tunnel`) `JASO_TRUST_PROXY=1`은 그대로 둡니다.

#### WSL 살려 두기·방문자·운영

**WSL 살려 두기** — WSL VM은 유휴 상태에서 꺼질 수 있습니다. Windows PowerShell에서 `powershell -ExecutionPolicy Bypass -File deploy\wsl\register-keepalive.ps1`를 한 번 실행하면 로그온할 때마다 창 없는 `wsl.exe` 프로세스 하나를 유지해 VM과 함께 서버·Tailscale·터널을 살려 둡니다(화면 잠금은 괜찮고, 로그아웃이나 PC 종료 시에는 멈춥니다). 배포판 이름이 Ubuntu가 아니면 `wsl-keepalive.vbs`의 `-d` 값을 바꾸세요.

**방문자 사용법** — 운영자가 전달한 주소(예: `https://jaso.<tailnet>.ts.net/jaso/`)를 열면 상단 배지가 `운영자 구독`으로 표시되고, **설정**에서 운영자에게 받은 **접속 키**를 넣으면 바로 쓸 수 있습니다(키는 그 브라우저에만 저장). 사이드바에는 호출 수·최근 등급과 운영자 구독의 **사용량 창** 상태, 기기 간 동기화 상태, 조직 텔레메트리 확인 결과가 보입니다. 폰에서 쓰려면 아래 「폰에 설치」, 폰과 PC를 오가며 쓰려면 「기기 간 동기화」를 보세요. 문제가 생기면 아래 「오류 안내」의 문구가 뜹니다.

**운영**

```bash
journalctl -u jaso -f                 # 서버 로그 (내용은 남지 않고 시각·IP·경로·상태·바이트, 텔레메트리 가드 상태 변화만)
systemctl status jaso jaso-tunnel     # 상태
sudo systemctl restart jaso           # 설정(/etc/jaso/jaso.env) 변경·코드 갱신(git pull) 후 재시작
claude auth status                    # 서비스 사용자로 실행 — 로그인이 끊겼으면 `claude` → /login 후 jaso 재시작
curl -s http://127.0.0.1:8080/api/health   # login.ok, usageWindow, queue, telemetry, sync 확인
bash deploy/wsl/install-funnel.sh --url    # 현재 공개 주소 (Tailscale Funnel)
sudo tailscale funnel status               # Funnel 상태
bash deploy/wsl/install-funnel.sh --off    # Funnel 공개 중지
bash deploy/wsl/install-tunnel.sh --url    # 현재 터널 주소 (빠른 터널)
sudo systemctl disable --now jaso jaso-tunnel   # 중지
```

접속 키 회전(모든 방문자가 새 키를 다시 넣어야 합니다):

```bash
NEW=$(node -e 'process.stdout.write(require("crypto").randomBytes(24).toString("base64url"))')
sudo sed -i "s/^JASO_ACCESS_KEY=.*/JASO_ACCESS_KEY=$NEW/" /etc/jaso/jaso.env && sudo systemctl restart jaso && echo "$NEW"
```

#### 기기 간 동기화 (암호화)

운영자 구독 서버로 연 페이지에서는 같은 프로젝트를 폰과 PC에서 번갈아 이어 쓸 수 있습니다. 내용은 **브라우저에서 암호화**되어 서버에는 암호문만 보관되고, 운영자도 풀 수 없습니다(종단 간 암호화). 아티팩트·API 키 모드에는 이 기능이 없습니다.

**쓰는 법 (예: PC → 폰)**

1. PC에서 **설정 → 기기 간 동기화 → 새 코드 만들기**. `jaso-xxxx-xxxx-xxxx-xxxx` 꼴의 **동기화 코드**가 생기고 지금 프로젝트가 서버에 올라갑니다. **코드 복사**로 복사해 둡니다.
2. 폰에서 같은 주소를 열고 **설정**에 접속 키와 그 동기화 코드를 넣고 **저장**. 서버에 있는 프로젝트를 먼저 가져옵니다. 폰에도 내용이 있고 그쪽이 더 최근이면 "서버에 이 코드로 저장된 프로젝트가 있습니다. 서버 버전으로 바꿀까요? (취소하면 지금 기기 내용을 서버에 올립니다)"라고 묻습니다.
3. 그다음부터는 자동입니다. 고칠 때마다 1.5초 뒤 서버에 올리고(Claude 작업이 도는 동안에는 기다렸다가 끝난 뒤), 페이지를 열 때와 다른 앱·탭에서 돌아올 때(20초에 한 번까지) 서버의 새 내용을 가져옵니다. 사이드바에 `동기화: 켜짐 · 마지막 HH:MM`이 보이고 **지금 동기화**로 바로 맞출 수 있습니다.
4. 두 기기에서 같은 사이에 고쳤으면 "다른 기기에서 바뀐 내용이 있습니다. 서버 버전을 가져올까요? (취소하면 이 기기 내용으로 덮어씁니다)"라고 묻습니다. 두 내용을 합치지는 않으므로 한쪽을 고릅니다.
5. 끄기: **동기화 끄기** — 이 기기의 동기화 상태만 지우고, 서버에 남은 암호화 사본도 지울지 묻습니다. 사본을 지워도 같은 코드로 동기화가 켜져 있는 다른 기기는 다음 동기화 때 "서버에 있던 이 코드의 동기화 사본이 없어졌습니다… 다시 올릴까요?"라고 묻고, **다시 올리기**를 누르면 그 기기의 내용이 서버에 다시 올라갑니다. 완전히 지우려면 그 기기에서 **취소**(그 기기의 동기화도 꺼짐)를 누르거나 미리 **동기화 끄기**를 하세요.

**암호화와 서버가 보는 것**

- 동기화 코드는 헷갈리는 글자(0·o·1·l·i)를 뺀 31종 문자 16자(약 79비트 무작위)이며 그 브라우저에만 저장되고 서버로는 보내지 않습니다.
- 브라우저가 코드에서 두 값을 만듭니다: 저장 위치 `id` = `SHA-256('jaso-sync-id:' + 코드)`의 앞 16바이트(32자리 16진수), 암호 키 = PBKDF2-SHA-256(150,000회) → AES-GCM 256비트. 프로젝트는 브라우저에서 무작위 IV로 암호화한 base64url 문자열로만 서버에 갑니다.
- 서버는 `JASO_DATA_DIR/<id>.json`에 `{ id, etag, updatedAt, payload(암호문), bytes, storedAt }`만 원자적으로 씁니다(install.sh 기준 `/var/lib/jaso/sync`, 0700). 요청 로그에는 `/api/sync/:id`라는 경로 이름만 남고 id·내용은 남지 않습니다. 동기화 API도 같은 **접속 키**로 인증합니다.
- 대신 **코드를 아는 사람은 누구나**(주소·접속 키와 함께) 그 프로젝트를 읽고 덮어쓸 수 있습니다. 비밀번호처럼 다루세요. 코드를 잃어버리면 서버 사본을 풀 방법이 없습니다(각 기기의 내용은 그대로 남습니다). 코드를 잘못 넣으면 "동기화 코드가 맞지 않아…" 안내가 뜹니다.

**한도** (환경 변수로 조정): 프로젝트 하나의 암호문 2MB(`JASO_SYNC_MAX_BYTES`, 넘으면 "프로젝트가 너무 커서 동기화할 수 없습니다(2MB 제한).") · 서버 전체 200개 코드(`JASO_SYNC_MAX_ITEMS`, 넘으면 새 코드는 507 `sync_full`) · 마지막 저장 뒤 180일이 지나면 삭제(`JASO_SYNC_TTL_DAYS`, 매시간 정리) · IP별 600초에 120회(`JASO_SYNC_RATE_LIMIT`, `/api/sample`과 별도). `JASO_SYNC=0`이면 동기화 API가 꺼지고(404) 설정에 동기화 칸이 나오지 않습니다.

#### 폰에 설치 (PWA)

앱에는 웹 앱 매니페스트(`jaso/manifest.webmanifest`)와 아이콘이 있어 폰 홈 화면에 앱처럼 추가할 수 있습니다. 홈 화면 아이콘은 추가할 때의 주소를 기억하므로 **바뀌지 않는 HTTPS 주소**가 필요합니다 — Tailscale Funnel(또는 이름 있는 터널) 주소를 쓰세요. 빠른 터널 주소는 다시 시작할 때마다 바뀌어 아이콘을 다시 추가해야 합니다.

- **iPhone·iPad (Safari)** — `https://jaso.<tailnet>.ts.net/jaso/`를 Safari로 열고 **공유** 버튼(iPhone은 화면 아래, iPad는 위) → **홈 화면에 추가** → **추가**.
- **Android (Chrome)** — 같은 주소를 Chrome으로 열고 오른쪽 위 **⋮** 메뉴 → **홈 화면에 추가**(또는 **앱 설치**) → **설치**/**추가**.

홈 화면에서 열면 주소창 없이 전체 화면으로 열립니다. 오프라인 캐시(서비스 워커)는 일부러 넣지 않았습니다 — 운영자 서버가 꺼져 있으면 어차피 Claude를 부를 수 없고, 오래된 화면이 남는 것을 피하기 위해서입니다. iPhone에서는 홈 화면 앱이 Safari와 저장 공간을 따로 쓰므로, 홈 화면 앱의 **설정**에 접속 키를 다시 넣고 동기화 코드로 프로젝트를 가져오세요.

#### 텔레메트리 가드

claude.ai Team·Enterprise 조직의 Owner는 **서버 관리 설정**(claude.ai 관리자 설정 > Claude Code)으로 모든 `claude` 프로세스에 환경 변수를 내려보낼 수 있습니다. 이 값은 헤드리스 `claude -p`에도 승인 대화상자 없이 적용되고 프로세스 환경 변수보다 우선하므로, 서버가 끌 수 없습니다. 그중 다섯 개 — `OTEL_LOG_USER_PROMPTS`, `OTEL_LOG_ASSISTANT_RESPONSES`, `OTEL_LOG_TOOL_DETAILS`, `OTEL_LOG_TOOL_CONTENT`, `OTEL_LOG_RAW_API_BODIES`(모두 기본 꺼짐) — 가 켜지면 방문자의 프롬프트·답변 **본문**이 조직의 OpenTelemetry 수집기로 갈 수 있습니다. 텔레메트리 가드는 이 설정이 켜져 있는지 **확인하고, 켜져 있으면 Claude 호출을 거부**합니다. 호출 수·토큰 같은 사용량 메타데이터 텔레메트리는 막지 않습니다.

**확인하는 곳** (순서대로, 각 파일 안의 `env` 블록을 모두 찾습니다)

1. `~/.claude/remote-settings.json` — CLI가 받아 둔 서버 관리 설정 캐시 (폴더는 `JASO_CLAUDE_CONFIG_DIR`, 없으면 `CLAUDE_CONFIG_DIR`)
2. `/etc/claude-code/managed-settings.json` — 파일 기반 관리 설정 (`JASO_MANAGED_SETTINGS_FILE`)
3. `~/.claude/settings.json` — 사용자 설정
4. 서버 프로세스 자신의 환경 변수

그리고 `claude doctor` 출력의 `Managed settings (remote): …` 줄로 조직이 원격 설정을 내려보내는지 봅니다. 값이 비어 있거나 `0`·`false`·`off`·`no`(대소문자 무시)면 꺼짐, 그 밖의 값(`OTEL_LOG_RAW_API_BODIES=file:<폴더>` 포함)은 켜짐으로 봅니다.

**판정** — `blocked`(어느 한 곳에서라도 켜짐) · `unknown`(켜진 것은 없지만, doctor가 원격 설정이 `loaded`라고 하는데 캐시 파일이 없거나 읽을 수 없어 조직 설정을 볼 수 없음) · `clear`(그 밖). 서버 시작 때(`claude doctor` 포함), 그 뒤 `JASO_TELEMETRY_RECHECK_MS`마다(기본 1시간 — 원격 설정도 매시간 갱신됩니다), 그리고 설정 폴더의 `remote-settings.json`·`settings.json`이 바뀌면 2초 뒤 다시 검사합니다. 상태가 바뀔 때마다 서버 로그에 한 줄을 남깁니다(키 이름과 출처 파일 이름만, 값·경로 없음).

**모드** (`JASO_TELEMETRY_GUARD`)

| 모드 | `blocked`일 때 | `unknown`일 때 |
| --- | --- | --- |
| `block` (기본) | 호출 거부 | 허용 |
| `strict` | 호출 거부 | 호출 거부 |
| `warn` | 허용 (사이드바·로그 경고만) | 허용 |
| `off` | 검사하지 않음 (health의 `telemetry`가 `null`) | — |

거부하면 `/api/sample`이 503 `telemetry_blocked`(`flags`: 켜진 키 이름 목록, `guardStatus`: `blocked`|`unknown`)를 돌려주고, 화면에는 "운영자 조직의 텔레메트리 설정이 본문 수집을 켜 두어 지금은 작성할 수 없습니다." 안내가 뜹니다(`strict` 모드에서 확인하지 못해 거부할 때는 "운영자 조직의 텔레메트리 설정을 확인할 수 없어(엄격 모드) 지금은 작성할 수 없습니다."). 가드는 요청이 대기열에서 차례를 기다린 뒤 CLI를 띄우기 직전에도 한 번 더 확인합니다. 사이드바에는 `조직 텔레메트리: 본문 수집 꺼짐 확인 (HH:MM)` 같은 상태가 보이고, `claude doctor`가 원격 설정 여부를 알려 주지 않았고(`remoteManaged: "unknown"`) 캐시도 없으면 `본문 수집 설정 없음 (조직 원격 설정 여부는 확인하지 못함, HH:MM)`으로 표시합니다. 재검사 때 `claude doctor`가 실패하거나 시간 안에 끝나지 않으면 마지막으로 읽은 결과를 그대로 씁니다(실패했다고 차단이 풀리지 않음). `/api/health`의 `telemetry`는 `{ mode, status, flags: [키 이름], remoteManaged: "loaded"|"none"|"unknown", checkedAt, cacheFile: "present"|"absent" }`이며 값이나 운영자 홈 경로는 넣지 않습니다. 또 `JASO_CHILD_ENV_PASSTHROUGH`에 다섯 이름을 적어도 자식 `claude`에는 넘기지 않고 시작 로그에 경고합니다.

**한계**

- 가드는 CLI가 디스크에 남긴 캐시를 읽을 뿐, 조직 Owner의 설정을 직접 볼 수는 없습니다. 캐시가 없으면 `unknown`이고 기본(`block`) 모드에서는 호출을 허용합니다. 확인되지 않은 상태에서도 막으려면 `JASO_TELEMETRY_GUARD=strict`를 쓰세요.
- 관리자가 설정을 바꾼 뒤 CLI가 새 설정을 받아 캐시에 쓰기 전까지는 가드가 알 수 없으므로, 그 사이의 호출은 막지 못할 수 있습니다.
- 그래서 운영 전에 서비스 사용자로 `~/.claude/remote-settings.json`의 `env` 블록(`OTEL_LOG_*` 항목)과 `claude doctor`의 `Managed settings (remote)` 줄을 직접 확인하고, 조직 관리자에게도 물어보세요.

#### 환경 변수·오류 안내

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
| `JASO_TRUST_PROXY` | `0` | `1`이면 방문자 IP를 `CF-Connecting-IP`(없으면 `X-Forwarded-For`의 마지막 값)에서 읽음. Funnel을 거친 요청(`Tailscale-Funnel-Request` 헤더)은 방문자가 위조할 수 있는 `CF-Connecting-IP`를 무시하고 Funnel이 넣는 `X-Forwarded-For`만 씀 — Funnel·터널 뒤에서 켬(install-funnel.sh·install-tunnel.sh가 켬) |
| `JASO_FIRST_OUTPUT_TIMEOUT_MS` / `JASO_TOTAL_TIMEOUT_MS` | `120000` / `600000` | 첫 출력·전체 시간 제한(넘으면 504 `timeout`) |
| `JASO_MODEL_{COMPLEX,DEFAULT,QUICK}` / `JASO_EFFORT_{…}` | `opus`/`high`, `sonnet`/`medium`, `sonnet`/`low` | 등급별 모델·노력 |
| `JASO_FALLBACK_MODEL` | `sonnet` | `--fallback-model`(선택한 모델과 다를 때만 전달, 빈 문자열이면 끔) |
| `JASO_WORK_DIR` | `<tmp>/jaso-work` | CLI 자식 프로세스의 빈 작업 폴더 |
| `JASO_LOGIN_PROBE` | `1` | 시작 시 실제 호출 1회로 로그인 검증(`0`이면 끔) |
| `JASO_ALLOW_API_KEY` | `0` | `1`이 아니면 자식 환경에서 `ANTHROPIC_API_KEY` 등을 제거(구독만 사용) |
| `JASO_LOG_LEVEL` | `info` | 요청마다 한 줄 로그. 프롬프트·응답·동기화 내용은 어떤 레벨에서도 남기지 않음 |
| `JASO_CHILD_ENV_PASSTHROUGH` | (없음) | 자식 `claude` 프로세스에 추가로 넘길 환경 변수 이름(쉼표 구분, 예: `HTTPS_PROXY,NO_PROXY`). 기본은 HOME·PATH 등 최소만 전달하므로 사내 프록시 뒤에서는 여기에 적어야 함. API 키·`JASO_ACCESS_KEY`·본문 텔레메트리 플래그(`OTEL_LOG_*` 다섯 개)는 적어도 넘기지 않음(경고 로그) |
| `CLAUDE_CODE_OAUTH_TOKEN` / `CLAUDE_CONFIG_DIR` | (없음) | `/login` 대신 `claude setup-token` 토큰으로 인증(설치 시 `CLAUDE_CODE_OAUTH_TOKEN=… bash deploy/wsl/install.sh` 로 넘기면 저장됨) / `~/.claude` 대신 쓸 설정 폴더 |
| `JASO_TELEMETRY_GUARD` | `block` | 텔레메트리 가드 모드: `block`(본문 수집이 확인되면 거부) · `strict`(확인할 수 없어도 거부) · `warn`(거부하지 않음) · `off`(검사하지 않음) |
| `JASO_CLAUDE_CONFIG_DIR` | `$CLAUDE_CONFIG_DIR` 또는 `~/.claude` | 가드가 `remote-settings.json`·`settings.json`을 찾고 변경을 감시하는 폴더 |
| `JASO_TELEMETRY_RECHECK_MS` | `3600000` | 가드 재검사 주기(밀리초) |
| `JASO_MANAGED_SETTINGS_FILE` | `/etc/claude-code/managed-settings.json` | 가드가 읽는 파일 기반 관리 설정 |
| `JASO_DATA_DIR` | `~/.local/share/jaso/sync` (install.sh는 `/var/lib/jaso/sync`) | 동기화 암호문 저장 폴더(0700으로 만듦) |
| `JASO_SYNC` | `1` | `0`이면 동기화 API를 끔(404) |
| `JASO_SYNC_MAX_BYTES` | `2097152` | 프로젝트 하나의 암호문 상한(바이트, 넘으면 413) |
| `JASO_SYNC_MAX_ITEMS` | `200` | 서버에 둘 동기화 레코드 수(넘으면 새 코드는 507 `sync_full`) |
| `JASO_SYNC_TTL_DAYS` | `180` | 마지막 저장 뒤 이 일수가 지난 레코드를 삭제(매시간 정리) |
| `JASO_SYNC_RATE_LIMIT` | `120/600` | 동기화 API의 IP별 요청 제한(`횟수/초`, `/api/sample`과 별도) |

**오류 안내** (방문자 화면에 뜨는 문구)

| HTTP | 코드 | 문구 | 언제 |
| --- | --- | --- | --- |
| 401 | `unauthorized` | 접속 키가 올바르지 않습니다. | 키가 없거나 틀림 |
| 413 | `prompt_too_large` | 보내는 내용이 너무 깁니다. 경험 카드나 공고 내용을 줄여 주세요. | 프롬프트·본문 상한 초과(동기화에서는 "프로젝트가 너무 커서 동기화할 수 없습니다(2MB 제한).") |
| 429 | `rate_limited` | 요청이 너무 많습니다. {n}초 후 다시 시도해 주세요. | IP별 요청 제한·인증 실패 반복 |
| 429 | `usage_limit` | 운영자 Claude 구독의 사용량 한도에 걸렸습니다. {시각} 이후 다시 시도해 주세요. | 운영자 구독의 사용량 창 소진 |
| 503 | `nologin` | 운영자의 Claude 로그인이 만료되었거나 설정되지 않았습니다. 운영자에게 알려 주세요. | 운영자 `claude` 로그인 끊김 |
| 503 | `busy` | 지금 다른 요청을 처리하고 있습니다. 잠시 후 다시 시도해 주세요. | 동시 처리(기본 1개 + 대기 6개) 초과 |
| 503 | `telemetry_blocked` | 운영자 조직의 Claude 텔레메트리 설정이 프롬프트·답변 본문 수집을 켜 두어 호출을 중단했습니다. 운영자에게 알려 주세요. | 텔레메트리 가드가 거부 (본문 수집이 켜진 것을 확인, `guardStatus: "blocked"`) |
| 503 | `telemetry_blocked` | 운영자 조직의 텔레메트리 설정을 확인할 수 없어(엄격 모드) 호출을 중단했습니다. 운영자에게 알려 주세요. | `strict` 모드에서 조직 설정을 확인하지 못해 거부 (`guardStatus: "unknown"`, `flags: []`) |
| 504 | `timeout` | 응답이 너무 오래 걸립니다. 운영자의 Claude 로그인 상태를 확인해야 할 수 있습니다. | 첫 출력·전체 시간 제한 초과 |
| 412 | `sync_conflict` | 다른 기기에서 먼저 저장한 내용이 있어 이번 저장을 적용하지 않았습니다. | 동기화: 다른 기기가 먼저 올림 — 앱이 어느 쪽을 쓸지 묻습니다 |
| 412 | `sync_missing` | 서버에 이 코드의 동기화 사본이 없습니다(다른 기기에서 삭제했거나 오래되어 만료됨). | 동기화: 이전에 받은 ETag로 올렸는데 서버 사본이 없음 — 앱이 다시 올릴지 묻습니다(지운 사본을 몰래 되살리지 않음) |
| 507 | `sync_full` | 서버의 동기화 저장 공간이 가득 찼습니다. 운영자에게 알려 주세요. | 동기화 레코드 수가 `JASO_SYNC_MAX_ITEMS`에 참 |

그 밖에 400 `invalid_request`, 422 `refused`(Claude가 거절), 502 `upstream_error`·`empty_completion`·`invalid_json`이 있으며 모두 다시 시도하라는 안내가 뜹니다.

> **주의 — 반드시 읽어 주세요**
>
> - **구독 좌석은 개인용입니다.** 운영자 구독 서버 모드는 운영자 한 사람의 Team(또는 Pro/Max) 좌석으로 모든 방문자의 요청을 처리합니다. 그 좌석의 5시간·주간 사용량 창을 접속 키를 가진 모두가 **함께** 소모하므로, 한도에 걸리면 운영자 본인도 못 쓰게 됩니다. 접속 키는 가족·친구 등 믿을 수 있는 소수에게만 주세요.
> - **약관.** Anthropic의 이용 약관은 구독 좌석을 1인 사용으로 봅니다. 접속 키를 불특정 다수에게 공개하거나 서비스처럼 운영하면 약관 위반이 될 수 있습니다. 공개 서비스가 필요하면 API 키 모드(건당 과금)를 쓰세요.
> - **운영자의 서버는 내용을 봅니다.** 방문자가 입력한 지원 정보·경험·자소서는 Claude를 부를 때마다 운영자의 PC를 거쳐 Claude로 전달됩니다. 서버는 저장하지 않고(`--no-session-persistence`, 로그에도 내용 없음) 통과만 시키지만, 방문자는 이 점을 알고 써야 합니다. 기기 간 동기화 사본은 브라우저에서 암호화되어 운영자도 읽을 수 없지만, Claude 호출 내용은 여전히 서버를 지나갑니다.
> - **조직(Team/Enterprise) 관리자의 텔레메트리 설정이 그대로 적용됩니다.** 서버가 실행하는 `claude` CLI는 운영자 계정의 **서버 관리 설정**(claude.ai 관리자 설정 > Claude Code)을 받아서 따르고, 이 설정은 환경 변수보다 우선하므로 서버가 끌 수 없습니다(헤드리스 실행에서도 승인 없이 적용). 관리자가 OpenTelemetry 수집을 켜 두었으면 호출 수·토큰·비용·`user.email` 같은 메타데이터는 조직 수집기로 전송됩니다. 본문 수집 토글(`OTEL_LOG_USER_PROMPTS`·`OTEL_LOG_ASSISTANT_RESPONSES`·`OTEL_LOG_TOOL_DETAILS`·`OTEL_LOG_TOOL_CONTENT`·`OTEL_LOG_RAW_API_BODIES`)이 켜진 것이 **확인되면 텔레메트리 가드가 Claude 호출을 막습니다**(기본 `block`). 다만 가드는 CLI가 받아 둔 캐시를 읽는 방식이라, 캐시가 없으면 확인 불가(`unknown`, 기본 모드에서는 허용)이고 설정이 바뀐 직후의 호출은 놓칠 수 있습니다. 운영 전에 `claude doctor`의 `Managed settings (remote)` 줄과 `~/.claude/remote-settings.json`의 `env` 블록을 확인하고, 필요하면 `JASO_TELEMETRY_GUARD=strict`를 쓰고, 조직 관리자에게도 물어본 뒤 방문자에게 알리세요.
> - **빠른 터널은 Cloudflare의 무료 편의 기능**이라 주소가 바뀌고 가용성이 보장되지 않습니다. 고정 주소가 필요하면 Tailscale Funnel(무료)이나 이름 있는 터널을 쓰세요. 어느 쪽이든 공개 주소는 누구나 찾을 수 있다고 보고 접속 키로 보호하세요.
> - **서버 없이 쓰는 길도 있습니다.** 자기 claude.ai 계정이 있는 사람은 위의 claude.ai 아티팩트 링크를 열면 **자기 구독**으로 같은 앱을 쓸 수 있습니다. 운영자 서버는 claude.ai 계정이 없는 사람을 위한 선택지입니다.

### 개발

```bash
npm install
npm test             # 단위 테스트 (node:test) — 앱 로직, 서버(가짜 claude CLI 사용, 실제 호출 없음), 텔레메트리 가드, 동기화 암호화·API
npm run e2e          # Playwright E2E — API 키 모드(모의 Anthropic API), 아티팩트 모드(가짜 window.claude), 운영자 구독 서버 모드(가짜 claude CLI), 기기 간 동기화·PWA·폰 화면(390×844)·텔레메트리 가드(가짜 claude CLI, 서버 2대). 스크린샷은 .playwright/ (처음 실행 시 Chromium을 내려받습니다)
npm start            # 운영자 구독 서버 로컬 실행 (JASO_ALLOW_ANON=1 을 앞에 붙이면 키 없이)
npm run build:artifact  # claude.ai 아티팩트용 페이지 생성
npm run build:icons  # jaso/icons/icon.svg → 홈 화면 아이콘 PNG(192·512·180·512 maskable) 생성 (Playwright Chromium 사용)
npm run vendor       # jaso/vendor/anthropic-sdk.mjs 재생성 (@anthropic-ai/sdk 브라우저 번들)
```

`jaso/vendor/anthropic-sdk.mjs`는 공식 `@anthropic-ai/sdk`를 esbuild로 브라우저용 ESM 번들한 파일이며, `index.html`의 import map이 `@anthropic-ai/sdk`를 이 파일로 연결합니다. 서버는 런타임 의존성이 없습니다(Node 내장 모듈만 사용).

```
jaso/
├─ index.html          # 앱 셸(API 키·운영자 구독 서버 모드 진입점), import map, 대화상자, 매니페스트·아이콘 링크
├─ manifest.webmanifest  # 홈 화면 설치(PWA) 정보 — 서비스 워커 없음
├─ icons/              # icon.svg 와 생성된 PNG 아이콘 (npm run build:icons)
├─ dist/artifact.html  # claude.ai 아티팩트용 본문(빌드 산출물)
├─ style.css
├─ vendor/anthropic-sdk.mjs   # API 키 모드에서만 동적 로드
├─ server/
│  ├─ server.mjs       # 운영자 구독 서버: 정적 서빙, /api/health, /api/sample(SSE 스트리밍), /api/sync/:id, claude -p 자식 프로세스 관리
│  ├─ lib.mjs          # 순수 헬퍼: 설정 파싱, 프롬프트 평탄화, stream-json 파서, 오류 분류, 인증, 속도 제한, 정적 경로 검사
│  ├─ telemetry-guard.mjs  # 텔레메트리 가드: 관리 설정·환경 변수의 본문 수집 플래그 검사, claude doctor, 재검사·파일 감시
│  └─ sync.mjs         # 기기 간 동기화 저장소: 레코드 하나 = 파일 하나(암호문), ETag·원자적 쓰기·만료 정리
└─ src/
   ├─ app.js           # UI 상태·렌더링·이벤트, 실행 환경 감지, 동기화 흐름
   ├─ agent.js         # 인터뷰 상태 관리, 작성/첨삭/수정 파이프라인, 공고 분석, 면접 질문
   ├─ llm-sample.js    # 구독 모드 제공자(sample: 프롬프트 합성, JSON 턴 인터뷰) — 아티팩트·서버 공용
   ├─ llm-remote.js    # 운영자 구독 서버 클라이언트(/api/sample 호출, SSE 파싱, 접속 키)
   ├─ llm-sdk.js       # Anthropic SDK 제공자(tool use 인터뷰 루프, 구조화 출력, 폴백)
   ├─ sync.js          # 동기화 코드, 키 유도(PBKDF2)·AES-GCM 암호화, /api/sync 클라이언트
   ├─ interview.js / experiences.js / errors.js   # 공통 헬퍼
   ├─ prompts.js       # 시스템 프롬프트, 도구/출력 스키마, 메시지 빌더 (한국어)
   ├─ api.js           # 모델 목록, 오류 문구, 비용 추정
   ├─ text.js          # 글자수 계산·판정, 스키마 검증 등 순수 함수
   ├─ presets.js       # 문항 템플릿·기업별 예시 세트
   └─ storage.js       # localStorage/sessionStorage (API 키·접속 키·동기화 상태 포함)
deploy/wsl/
├─ install.sh / jaso.service               # WSL2 systemd 서비스 설치(운영자 구독 모드)
├─ install-funnel.sh                       # Tailscale Funnel — 무료 고정 주소(권장)
├─ install-tunnel.sh / jaso-tunnel.service # cloudflared 빠른 터널(주소 변동)
└─ register-keepalive.ps1 / wsl-keepalive.vbs   # Windows 쪽 WSL 유지
scripts/
├─ build-artifact.mjs  # claude.ai 아티팩트 페이지 생성
└─ build-icons.mjs     # 아이콘 PNG 생성
```

### 비용·주의

- 문항 하나를 완성하는 데 보통 Claude 호출 3~7회(초안 1, 첨삭 1~3, 수정 0~2, 글자수 조정 0~2)가 듭니다. 아티팩트 모드에서는 보는 사람의 claude.ai 사용량이, 운영자 구독 서버 모드에서는 **운영자**의 사용량이 쓰이고(한도에 걸리면 안내된 시각 이후 재시도), API 키 모드에서는 사이드바에 토큰·추정 비용이 누적 표시됩니다.
- 기업별 문항 프리셋은 공개 자료를 정리한 **참고용**입니다. 문항 문구·글자수·공백 기준은 채용 회차마다 바뀌므로 반드시 실제 공고를 확인하세요.
- AI가 만든 초안을 그대로 제출하기보다, 인터뷰에서 말한 자기 경험이 정확히 반영됐는지 확인하고 표현을 자기 말로 다듬는 것을 권합니다.
