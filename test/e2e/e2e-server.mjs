// 서버 모드 E2E: 실제 jaso 서버(jaso/server/server.mjs)를 가짜 claude CLI로 띄우고,
// Playwright Chromium으로 접속 키 입력 → 공고 분석 → 인터뷰 → 작성·첨삭 → 완성·다운로드 → 잘못된 키(401) 흐름을 검증한다.
// 실제 `claude` 바이너리나 네트워크 API는 쓰지 않는다.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '../..');
const SERVER = path.join(REPO, 'jaso', 'server', 'server.mjs');
const FAKE_CLI = path.join(REPO, 'test', 'helpers', 'fake-claude-cli.mjs');
const SHOTS = process.env.E2E_SHOTS || path.join(REPO, '.playwright');
fs.mkdirSync(SHOTS, { recursive: true });
const KEY = 'e2e-key-123';
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'jaso-e2e-server-'));
const FAKE_LOG = path.join(TMP, 'fake-calls.log');
const FAKE_STATE = path.join(TMP, 'fake-brain-state.json');

// ───────────── 서버 띄우기 (JASO_PORT=0 → stdout의 listening 줄에서 포트를 읽는다) ─────────────
const serverEnv = {
  PATH: process.env.PATH, HOME: process.env.HOME, LANG: process.env.LANG ?? 'C.UTF-8',
  JASO_PORT: '0', JASO_HOST: '127.0.0.1', JASO_ACCESS_KEY: KEY, JASO_CLAUDE_BIN: FAKE_CLI, JASO_LOGIN_PROBE: '0',
  JASO_WORK_DIR: path.join(TMP, 'work'),
  // 텔레메트리 가드·동기화 저장소가 이 기계의 실제 ~/.claude, /etc/claude-code, ~/.local/share/jaso 를 쓰지 않도록 임시 경로로 고정한다
  JASO_CLAUDE_CONFIG_DIR: path.join(TMP, 'claude-config'), JASO_MANAGED_SETTINGS_FILE: path.join(TMP, 'managed-settings.json'),
  JASO_DATA_DIR: path.join(TMP, 'sync-data'),
  // 가짜 CLI에는 호출 기록 파일(등급→모델 매핑 검증용)과 두뇌 상태 파일(호출마다 새 프로세스이므로 인터뷰 턴·첨삭 번갈이를 이어 가기 위해)만 넘긴다
  JASO_CHILD_ENV_PASSTHROUGH: 'FAKE_LOG,FAKE_STATE', FAKE_LOG, FAKE_STATE,
};
const server = spawn(process.execPath, [SERVER], { env: serverEnv, stdio: ['ignore', 'pipe', 'pipe'] });
let serverLog = '';
server.stderr.on('data', (d) => { serverLog += d; });
const base = await new Promise((resolve, reject) => {
  let out = '';
  const timer = setTimeout(() => reject(new Error(`서버가 10초 안에 시작되지 않음\n${serverLog}`)), 10000);
  server.stdout.on('data', (d) => {
    out += d;
    const m = /jaso server listening on (http:\/\/127\.0\.0\.1:\d+\/)\n/.exec(out);
    if (m) { clearTimeout(timer); resolve(m[1]); }
  });
  server.once('exit', (code) => { clearTimeout(timer); reject(new Error(`서버가 먼저 종료됨 code=${code}\n${serverLog}`)); });
});

function stopServer() {
  return new Promise((resolve) => {
    if (server.exitCode !== null || server.signalCode !== null) return resolve(server.exitCode);
    const t = setTimeout(() => server.kill('SIGKILL'), 8000);
    server.once('exit', (code) => { clearTimeout(t); resolve(code); });
    server.kill('SIGTERM');
  });
}

const readFakeLog = () => {
  try { return fs.readFileSync(FAKE_LOG, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; }
};

// ───────────── 브라우저 ─────────────
// 크로미움은 <a download> 파일명을 브라우저 프로세스의 로캘 인코딩으로 바꾼다. 로캘이 없는(C/POSIX) 컨테이너에서는
// 한글 파일명이 'download'로 바뀌므로, UTF-8 로캘이 아니면 브라우저에만 C.UTF-8 을 준다 (앱 코드와는 무관한 환경 문제).
const utf8Locale = /utf-?8/i.test(process.env.LC_ALL || process.env.LC_CTYPE || process.env.LANG || '');
const browser = await chromium.launch({ env: utf8Locale ? process.env : { ...process.env, LC_ALL: 'C.UTF-8' } });
const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, locale: 'ko-KR', acceptDownloads: true });
const page = await context.newPage();
const consoleErrors = [];
const requests = [];
page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()); });
page.on('pageerror', (e) => consoleErrors.push(`pageerror: ${e.message}`));
page.on('request', (r) => requests.push(r.url()));
const shot = (name) => page.screenshot({ path: path.join(SHOTS, `${name}.png`), fullPage: true });
const step = (name) => console.log(`✓ ${name}`);
const dialogOpen = () => page.evaluate(() => document.querySelector('#settings-dialog').open);

try {
  // 서버 자체: health 모양
  const health = await (await fetch(`${base}api/health`)).json();
  assert.equal(health.service, 'jaso');
  assert.equal(health.runtime, 'server');
  assert.equal(health.auth, 'key');
  assert.equal(health.login.ok, true, `login: ${JSON.stringify(health.login)}`);
  assert.deepEqual(health.tiers.complex, { model: 'opus', effort: 'high' });
  assert.equal(typeof health.limits.maxPromptBytes, 'number');
  assert.equal(health.telemetry?.status, 'clear', `telemetry: ${JSON.stringify(health.telemetry)}`);
  assert.equal(health.sync?.enabled, true);
  const noKey = await fetch(`${base}api/sample`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"input":"x"}' });
  assert.equal(noKey.status, 401);
  assert.equal(noKey.headers.get('www-authenticate'), 'Bearer');
  step(`서버 기동 (${base}) + /api/health 모양 + 키 없는 /api/sample 401`);

  // 부팅: health를 감지해 서버 모드로 들어간다
  await page.goto(`${base}jaso/`, { waitUntil: 'networkidle' });
  await page.waitForSelector('#f-company');
  await page.waitForFunction(() => window.__jaso && window.__jaso.runtime.checking === false, null, { timeout: 10000 });
  assert.equal(await page.locator('#runtime-badge').textContent(), '운영자 구독');
  assert.equal(await page.evaluate(() => window.__jaso.runtime.server), true);
  assert.equal(await page.locator('#stage .notice.info').count(), 0, '확인 중 안내는 사라져야 함');
  assert.equal(await page.locator('#stage .notice:has-text("접속 키")').count(), 1, '접속 키 안내');
  assert.equal(await page.locator('#stage .notice:has-text("API 키")').count(), 0, 'API 키 안내가 없어야 함');
  assert.match(await page.locator('#site-footer').textContent(), /운영자의 서버를 거쳐/);
  assert.match(await page.locator('#side').textContent(), /사용량 \(운영자 구독\)/);
  await shot('s1-server-boot');
  step('서버 모드 부팅 (배지 운영자 구독, 접속 키 안내, 푸터·사용량)');

  // 키 없이 첫 Claude 동작 → 설정 대화상자 (서버 모드 UI)
  await page.fill('#f-company', '네이버');
  await page.fill('#f-role', '백엔드 개발');
  await page.fill('#f-jd', '[네이버 백엔드 신입 채용] 자격요건: Java/Spring. 자소서 문항 1. 지원 동기(1000자) 2. 협업 갈등(700자)');
  assert.equal(await page.locator('button[data-action="analyze-jd"]').isDisabled(), false);
  await page.click('button[data-action="analyze-jd"]');
  await page.waitForFunction(() => document.querySelector('#settings-dialog').open, null, { timeout: 5000 });
  assert.equal(await page.locator('#s-accesskey').isVisible(), true, '접속 키 입력 표시');
  assert.equal(await page.locator('#s-apikey').isVisible(), false, 'API 키 입력 숨김');
  assert.equal(await page.locator('#s-tier').isVisible(), true, '모델 등급 선택 표시');
  assert.equal(await page.locator('#settings-dialog .notice[data-mode="server"]').isVisible(), true, '서버 모드 안내 표시');
  assert.equal(await page.locator('button[data-action="clear-access-key"]').isVisible(), true);
  assert.equal(await page.locator('button[data-action="clear-key"]').isVisible(), false, 'API 키 삭제 버튼은 숨김');
  assert.equal(await page.locator('.q-row').count(), 0, '키 없이 호출되지 않아야 함');
  await shot('s1-server-settings');
  await page.fill('#s-accesskey', KEY);
  await page.click('#settings-form button[type=submit]');
  await page.waitForFunction(() => !document.querySelector('#settings-dialog').open);
  assert.equal(await page.evaluate(() => localStorage.getItem('jaso.accessKey.v1')), JSON.stringify(KEY), '접속 키는 localStorage에 저장');
  assert.equal(await page.locator('#stage .notice:has-text("접속 키")').count(), 0, '키를 넣으면 안내가 사라짐');
  step('키 없이 공고 분석 클릭 → 설정 대화상자(서버 모드 UI) → 접속 키 저장');

  // 공고 분석 (schema → data)
  await page.click('button[data-action="analyze-jd"]');
  await page.waitForSelector('.q-row', { timeout: 15000 });
  assert.equal(await page.locator('.q-row').count(), 2);
  assert.equal(await page.inputValue('.q-row[data-qid="q1"] input[data-qbind="limit"]'), '1000');
  let log = readFakeLog();
  assert.equal(log.length, 1, `CLI 호출 1회: ${JSON.stringify(log)}`);
  assert.equal(log[0].hasSchema, true, '공고 분석은 --json-schema');
  assert.equal(log[0].model, 'sonnet', '공고 분석은 default 등급(sonnet)');
  assert.equal(log[0].format, 'stream-json');
  step('공고 분석 → 문항 2개 (서버가 CLI를 --json-schema, sonnet 으로 실행)');

  // 인터뷰 3턴 (대화 기록 → 서버가 [[USER]]/[[ASSISTANT]]로 펼쳐 CLI에 전달)
  await page.click('button[data-action="start-interview"]');
  await page.waitForSelector('#iv-answer:not([disabled])', { timeout: 15000 });
  assert.match(await page.locator('.msg.agent').first().textContent(), /경험 후보를 2~3개/);
  await page.fill('#iv-answer', '캡스톤 프로젝트에서 API 성능을 개선했습니다.');
  await page.click('button[data-action="iv-send"]');
  await page.waitForFunction(() => document.querySelectorAll('.msg.agent:not(.streaming)').length >= 2, null, { timeout: 15000 });
  await page.waitForSelector('#iv-answer:not([disabled])');
  assert.equal(await page.locator('#side .exp').count(), 1, '경험 카드 1개 저장');
  await page.fill('#iv-answer', '기능 중복으로 다툰 적이 있어요.');
  await page.click('button[data-action="iv-send"]');
  await page.waitForSelector('button[data-action="go-write"]', { timeout: 15000 });
  assert.equal(await page.locator('#side .exp').count(), 2);
  assert.match(await page.locator('.msg.note').textContent(), /인터뷰 요약/);
  log = readFakeLog();
  const ivCalls = log.filter((c) => c.inputKind === 'messages');
  assert.equal(ivCalls.length, 3, `인터뷰 CLI 호출 3회: ${JSON.stringify(log)}`);
  assert.deepEqual(ivCalls.map((c) => c.turns), [1, 3, 5], '대화 기록이 메시지 배열로 전달됨');
  assert.ok(ivCalls.every((c) => c.hasSchema && c.model === 'sonnet'), '인터뷰 턴은 schema + default 등급');
  await shot('s1-server-interview');
  step('인터뷰 3턴 → 경험 카드 2개, 종료 (SSE JSON 턴)');

  // 작성·첨삭
  await page.click('button[data-action="go-write"]');
  await page.waitForSelector('button[data-action="write-all"]');
  assert.match(await page.locator('#stage .card-title-sub').first().textContent(), /운영자 구독, 작성 등급 complex/);
  await page.click('button[data-action="write-all"]');
  await page.waitForFunction(() => {
    const pills = [...document.querySelectorAll('.answer-card > .card-head .pill')];
    return pills.length >= 2 && !document.querySelector('.pill.busy') && pills.every((p) => /첨삭 \d+점/.test(p.textContent));
  }, null, { timeout: 60000 });
  const pills = await page.locator('.answer-card > .card-head .pill').allTextContents();
  assert.equal(pills.length, 2, pills.join(','));
  assert.ok(pills.every((t) => /첨삭 \d+점/.test(t)), pills.join(','));
  const q1 = await page.inputValue('#answer-q1');
  assert.ok(q1.startsWith('[성능 개선으로 증명한 집요함]'), q1.slice(0, 40));
  assert.match(q1, /입사 후 2년 안에는/, '첨삭 반영본이 현재 버전');
  assert.ok((await page.locator('.answer-card[data-qid="q1"] .versions .v').count()) >= 2, '버전 2개 이상');
  log = readFakeLog();
  // 초안·첨삭 반영은 writer 역할(complex → opus/high), 글자수 조정은 default 등급(sonnet)
  const textCalls = log.filter((c) => c.inputKind === 'string' && !c.hasSchema);
  const complexCalls = textCalls.filter((c) => c.model === 'opus');
  assert.ok(complexCalls.length >= 4 && complexCalls.every((c) => c.effort === 'high'), `작성은 complex 등급(opus/high): ${JSON.stringify(textCalls)}`);
  assert.ok(textCalls.every((c) => c.model === 'opus' || (c.model === 'sonnet' && c.effort === 'medium')), `그 외 텍스트 호출은 default 등급: ${JSON.stringify(textCalls)}`);
  assert.ok(log.some((c) => c.inputKind === 'string' && c.hasSchema && c.model === 'sonnet'), '첨삭은 schema + default 등급');
  assert.match(await page.locator('#side').textContent(), /최근 등급/);
  await shot('s1-server-write');
  step('전체 작성: 초안→첨삭→수정→첨삭 완료 (작성 opus/high, 첨삭 sonnet)');

  // 완성: 면접 질문 + <a download> 로 TXT 저장
  await page.click('button[data-action="go-done"]');
  await page.waitForSelector('button[data-action="prep"]');
  assert.equal(await page.locator('.final').count(), 2);
  await page.click('button[data-action="prep"]');
  await page.waitForSelector('.prep-q', { timeout: 15000 });
  assert.equal(await page.locator('.prep-q').count(), 2);
  const [download] = await Promise.all([
    page.waitForEvent('download', { timeout: 10000 }),
    page.click('button[data-action="download-txt"]'),
  ]);
  assert.match(download.suggestedFilename(), /자기소개서\.txt$/, `다운로드 파일명: ${download.suggestedFilename()}`);
  const downloaded = await download.path();
  const saved = fs.readFileSync(downloaded, 'utf8');
  assert.ok(saved.length > 200, `저장된 내용 ${saved.length}자`);
  assert.match(saved, /네이버 백엔드 개발 자기소개서/);
  await shot('s1-server-done');
  step(`완성: 면접 질문 2개 + TXT 다운로드 (${download.suggestedFilename()}, ${saved.length}자)`);

  // 요청 경로·콘솔: SDK 번들과 api.anthropic.com 은 전혀 쓰지 않고, 모든 호출은 /api/sample 로 간다
  assert.ok(!requests.some((u) => /anthropic-sdk|api\.anthropic\.com/.test(u)), 'SDK 번들·Anthropic API 요청 없음');
  const sampleRequests = requests.filter((u) => u === `${base}api/sample`);
  assert.ok(sampleRequests.length >= 8, `/api/sample 요청 ${sampleRequests.length}회`);
  assert.equal(readFakeLog().length, sampleRequests.length, '요청 수 = CLI 실행 수');
  assert.deepEqual(consoleErrors, [], `콘솔 오류: ${consoleErrors.join(' | ')}`);
  step(`요청 경로 검증 (/api/sample ${sampleRequests.length}회, 외부 요청 0, 콘솔 오류 0)`);

  // 잘못된 키 → 401 → 토스트 + 설정 대화상자(접속 키 입력에 포커스)
  await page.click('#btn-settings');
  await page.waitForFunction(() => document.querySelector('#settings-dialog').open);
  await page.fill('#s-accesskey', 'wrong-key');
  await page.click('#settings-form button[type=submit]');
  await page.waitForFunction(() => !document.querySelector('#settings-dialog').open);
  assert.equal(await page.evaluate(() => window.__jaso.state.accessKey), 'wrong-key');
  const callsBefore = readFakeLog().length;
  await page.click('button[data-action="prep"]');
  await page.waitForFunction(() => document.querySelector('#settings-dialog').open, null, { timeout: 10000 });
  assert.equal(await page.evaluate(() => document.activeElement?.id), 's-accesskey', '401이면 접속 키 입력에 포커스');
  const toasts = await page.locator('#toast .toast').allTextContents();
  assert.ok(toasts.some((t) => t.includes('접속 키')), `토스트: ${JSON.stringify(toasts)}`);
  assert.equal(readFakeLog().length, callsBefore, '401이면 CLI는 실행되지 않음');
  assert.equal(await page.evaluate(() => window.__jaso.state.ui.busy), null, '작업 상태가 풀려야 함');
  await shot('s1-server-unauthorized');
  // 프레임에서 받은 401은 크로미움이 콘솔 오류로 찍는다 — 일부러 틀린 키를 보낸 이 한 건만 허용
  const unexpected = consoleErrors.filter((t) => !/Failed to load resource: .* 401/.test(t));
  assert.deepEqual(unexpected, [], `콘솔 오류: ${unexpected.join(' | ')}`);
  assert.ok(consoleErrors.length <= 1, `401 리소스 오류 로그만 있어야 함: ${consoleErrors.join(' | ')}`);
  await page.fill('#s-accesskey', KEY);
  await page.click('#settings-form button[type=submit]');
  await page.waitForFunction(() => !document.querySelector('#settings-dialog').open);
  assert.equal(await dialogOpen(), false);
  step('잘못된 접속 키 → 401 → 토스트 + 설정 대화상자 포커스');

  // 새로고침 후에도 서버 모드·키·상태 유지
  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForFunction(() => window.__jaso && window.__jaso.runtime.checking === false, null, { timeout: 10000 });
  assert.equal(await page.locator('#runtime-badge').textContent(), '운영자 구독');
  assert.equal(await page.evaluate(() => window.__jaso.state.accessKey), KEY);
  await page.waitForSelector('.final');
  assert.equal(await page.locator('.final').count(), 2);
  assert.equal(await page.locator('.prep-q').count(), 2);
  step('새로고침 후 서버 모드·접속 키·결과 유지');

  console.log(`\nE2E(서버) 통과. /api/sample 요청 ${sampleRequests.length}회, CLI 실행 ${readFakeLog().length}회. 스크린샷: ${SHOTS}`);
} catch (err) {
  await shot('s1-server-failure').catch(() => {});
  console.error('E2E(서버) 실패:', err);
  console.error('console errors:', consoleErrors);
  try {
    const diag = await page.evaluate(() => ({
      busy: window.__jaso?.state.ui.busy,
      runtime: { server: window.__jaso?.runtime.server, checking: window.__jaso?.runtime.checking, auth: window.__jaso?.runtime.serverInfo?.auth, login: window.__jaso?.runtime.serverInfo?.login },
      toasts: [...document.querySelectorAll('.toast')].map((t) => t.textContent),
      pills: [...document.querySelectorAll('.pill')].map((p) => `${p.className}:${p.textContent}`),
      answers: Object.fromEntries(Object.entries(window.__jaso?.state.project.answers ?? {}).map(([k, a]) => [k, { status: a.status, error: a.error, versions: a.versions.map((v) => v.label) }])),
    }));
    console.error('diag:', JSON.stringify(diag, null, 1));
  } catch (e) { console.error('diag failed', e.message); }
  console.error('fake CLI log:', JSON.stringify(readFakeLog().slice(-6)));
  console.error('server log tail:\n' + serverLog.split('\n').slice(-20).join('\n'));
  process.exitCode = 1;
} finally {
  await browser.close();
  const code = await stopServer();
  if (code !== 0) {
    console.error(`서버가 SIGTERM 뒤 0이 아닌 코드로 종료: ${code}`);
    process.exitCode = 1;
  }
  fs.rmSync(TMP, { recursive: true, force: true });
}
