// 브라우저 E2E: 정적 서버 + Playwright Chromium + 모의 Anthropic API (page.route)
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { createMockApi, toSSE } from './mock-api.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../jaso');
const SHOTS = process.env.E2E_SHOTS || path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../.playwright');
fs.mkdirSync(SHOTS, { recursive: true });
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json' };

const server = http.createServer((req, res) => {
  let p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  if (p.endsWith('/')) p += 'index.html';
  const file = path.join(ROOT, p);
  if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); res.end('not found'); return; }
  res.writeHead(200, { 'content-type': MIME[path.extname(file)] ?? 'application/octet-stream' });
  fs.createReadStream(file).pipe(res);
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}/`;

const mock = createMockApi();
const browser = await chromium.launch();
const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, locale: 'ko-KR' });
const page = await context.newPage();
const consoleErrors = [];
page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()); });
page.on('pageerror', (e) => consoleErrors.push(`pageerror: ${e.message}`));

const apiRequests = [];
await context.route('https://api.anthropic.com/**', async (route) => {
  const req = route.request();
  const cors = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': 'POST, OPTIONS, GET', 'access-control-expose-headers': '*' };
  if (req.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: cors });
  const body = JSON.parse(req.postData() ?? '{}');
  apiRequests.push({ headers: req.headers(), body });
  const message = mock.respond(body);
  await route.fulfill({ status: 200, headers: { ...cors, 'content-type': 'text/event-stream' }, body: toSSE(message) });
});

const shot = (name) => page.screenshot({ path: path.join(SHOTS, `${name}.png`), fullPage: true });
const step = (name) => console.log(`✓ ${name}`);

try {
  await page.goto(base, { waitUntil: 'networkidle' });
  assert.match(await page.title(), /자소서 에이전트/);
  await page.waitForSelector('#f-company');
  await shot('01-setup-empty');
  step('페이지 로드');

  // 설정: API 키 입력
  await page.click('#btn-settings');
  await page.fill('#s-apikey', 'sk-ant-test-key');
  await page.selectOption('#s-effort', 'high');
  await page.click('#settings-form button[type=submit]');
  await page.waitForFunction(() => !document.querySelector('#settings-dialog').open);
  assert.equal(await page.locator('.notice:has-text("아직 API 키가 없습니다")').count(), 0);
  step('API 키 설정');

  // 지원 정보 + 공고 분석
  await page.fill('#f-company', '네이버');
  await page.fill('#f-role', '백엔드 개발');
  await page.fill('#f-bg', '컴퓨터공학 졸업 예정, 스프링 기반 프로젝트 2회');
  await page.fill('#f-jd', '[네이버 백엔드 신입 채용] 자격요건: Java/Spring, 대규모 트래픽 경험 우대. 자기소개서 문항 1. 지원 동기(1000자) 2. 협업 갈등 해결 경험(700자)');
  // 붙여넣기 직후 첫 클릭이 먹어야 한다(재렌더로 버튼이 교체되면 안 됨)
  assert.equal(await page.locator('button[data-action="analyze-jd"]').isDisabled(), false, '입력 즉시 분석 버튼 활성화');
  await page.click('button[data-action="analyze-jd"]');
  await page.waitForSelector('.q-row', { timeout: 15000 });
  assert.equal(await page.locator('.q-row').count(), 2);
  assert.equal(await page.inputValue('.q-row[data-qid="q1"] input[data-qbind="limit"]'), '1000');
  assert.equal(await page.inputValue('.q-row[data-qid="q1"] select[data-qbind="mode"]'), 'with');
  assert.ok((await page.locator('.chip.static').allTextContents()).includes('Java/Spring'));
  await shot('02-setup-filled');
  step('공고 분석 → 문항 2개 추출');

  // 인터뷰
  await page.click('button[data-action="start-interview"]');
  await page.waitForSelector('#iv-answer:not([disabled])', { timeout: 15000 });
  assert.match(await page.locator('.msg.agent').first().textContent(), /경험 후보를 2~3개/);
  assert.match(await page.locator('.msg.agent .why').first().textContent(), /전체 그림/);
  await shot('03-interview-q1');
  await page.fill('#iv-answer', '캡스톤 프로젝트에서 API 성능을 개선했고, 동아리에서 예산을 관리했습니다.');
  await page.keyboard.press('Control+Enter');
  await page.waitForFunction(() => document.querySelectorAll('.msg.agent:not(.streaming)').length >= 2, null, { timeout: 15000 });
  await page.waitForSelector('#iv-answer:not([disabled])');
  assert.equal(await page.locator('#side .exp').count(), 1, '경험 카드 1개 저장');
  assert.match(await page.locator('#side .exp .t').first().textContent(), /3초→0.4초/);
  await page.fill('#iv-answer', '기능을 중복 구현해서 다툰 적이 있어요. 주간 회의를 도입해 역할을 문서로 정했습니다.');
  await page.click('button[data-action="iv-send"]');
  await page.waitForSelector('button[data-action="go-write"]', { timeout: 15000 });
  assert.equal(await page.locator('#side .exp').count(), 2);
  assert.match(await page.locator('.msg.note').textContent(), /인터뷰 요약/);
  await shot('04-interview-done');
  step('인터뷰 3턴 → 경험 카드 2개, 종료');

  // 인터뷰 요청 형태 검증 (두 번째 요청: assistant thinking 블록 되돌려 보냄, tool_result 한 메시지)
  const iv2req = apiRequests.filter((r) => r.body.tools)[1];
  const iv2 = iv2req.body;
  assert.equal(iv2.messages[1].role, 'assistant');
  assert.equal(iv2.messages[1].content[0].type, 'thinking');
  assert.equal(iv2.messages[1].content[0].signature, 'mock-signature');
  assert.equal(iv2.messages[2].content[0].type, 'tool_result');
  assert.equal(iv2.messages[2].content[0].tool_use_id, 'toolu_ask1');
  assert.equal(iv2.fallbacks, 'default');
  assert.ok(!('betas' in iv2), 'betas는 본문이 아니라 헤더로 전송');
  assert.match(iv2req.headers['anthropic-beta'] ?? '', /server-side-fallback-2026-07-01/);
  assert.equal(iv2.tools[0].eager_input_streaming, true);
  assert.equal(iv2.tools[0].strict, true);
  assert.ok(!('thinking' in iv2));
  const hdr = apiRequests[0].headers;
  assert.equal(hdr['x-api-key'], 'sk-ant-test-key');
  assert.equal(hdr['anthropic-dangerous-direct-browser-access'], 'true');
  assert.match(hdr['anthropic-beta'] ?? '', /server-side-fallback-2026-07-01/);
  step('API 요청 형태 검증 (thinking 되돌리기, fallbacks, strict, 헤더)');

  // 작성·첨삭
  await page.click('button[data-action="go-write"]');
  await page.waitForSelector('button[data-action="write-all"]');
  await page.click('button[data-action="write-all"]');
  await page.waitForFunction(() => {
    const pills = [...document.querySelectorAll('.answer-card > .card-head .pill')];
    return pills.length >= 2 && !document.querySelector('.pill.busy') && pills.every((p) => /첨삭 \d+점/.test(p.textContent));
  }, null, { timeout: 60000 });
  const pills = await page.locator('.answer-card > .card-head .pill').allTextContents();
  assert.equal(pills.length, 2);
  assert.ok(pills.every((t) => /첨삭 \d+점/.test(t)), pills.join(','));
  const q1Text = await page.inputValue('#answer-q1');
  assert.ok(q1Text.startsWith('[성능 개선으로 증명한 집요함]'), q1Text.slice(0, 40));
  assert.match(q1Text, /입사 후 2년 안에는/, '첨삭 반영본이 현재 버전');
  assert.ok((await page.locator('.answer-card[data-qid="q1"] .versions .v').count()) >= 2, '버전 2개 이상');
  assert.match(await page.locator('.answer-card[data-qid="q1"] .critique .total').textContent(), /9\d|100/);
  // q2는 700자 제한: 초안이 길면 글자수 조정 버전이 생겨야 함
  const q2Labels = await page.locator('.answer-card[data-qid="q2"] .versions .v').allTextContents();
  assert.ok(q2Labels.some((l) => l.includes('글자수 조정')), q2Labels.join(','));
  assert.match(await page.locator('#count-q2 .count').textContent(), /범위 내/);
  const q2Count = await page.evaluate(() => { const s = window.__jaso.state; const a = s.project.answers.q2; const v = a.versions.find((x) => x.id === a.currentVersionId); return Array.from(v.text.replace(/\r\n?/g, '\n')).length; });
  assert.ok(q2Count >= 630 && q2Count <= 700, `q2 글자수 ${q2Count}`);
  await shot('05-write-done');
  step('전체 작성: 초안→첨삭→수정→첨삭→(글자수 조정) 완료');

  // 편집 프리셋 → 새 버전
  const before = (await page.locator('.answer-card[data-qid="q1"] .versions .v').count());
  await page.click('.answer-card[data-qid="q1"] button[data-preset="concise"]');
  await page.waitForFunction((n) => document.querySelectorAll('.answer-card[data-qid="q1"] .versions .v').length > n, before, { timeout: 15000 });
  assert.match(await page.inputValue('#answer-q1'), /\(요청 반영\)/);
  step('편집 프리셋 → 새 버전');

  // 선택 구간 수정
  await page.evaluate(() => { const ta = document.querySelector('#answer-q1'); const i = ta.value.indexOf('숫자로 말하는 습관'); ta.focus(); ta.setSelectionRange(i, i + '숫자로 말하는 습관'.length); });
  await page.fill('#edit-input-q1', '더 자연스럽게');
  await page.click('.answer-card[data-qid="q1"] button[data-action="edit-one"]');
  await page.waitForFunction(() => document.querySelector('#answer-q1').value.includes('측정값을 공유하는 습관'), null, { timeout: 15000 });
  assert.ok(apiRequests.at(-1).body.messages[0].content.includes('[수정할 구간'));
  step('선택 구간 부분 수정');

  // 버전 전환: 초안으로 되돌리면 이후 수정 내용이 사라져야 한다
  await page.click('.answer-card[data-qid="q1"] .versions .v:has-text("초안")');
  const draftText = await page.inputValue('#answer-q1');
  assert.ok(draftText.startsWith('[성능 개선으로 증명한 집요함]'));
  assert.ok(!draftText.includes('측정값을 공유하는 습관'), '초안에는 부분 수정 내용이 없어야 함');
  assert.ok(!draftText.includes('(요청 반영)'));
  assert.ok(await page.locator('.answer-card[data-qid="q1"] .versions .v.current').textContent().then((t) => t.includes('초안')));
  step('버전 전환');

  // 완성 + 면접 예상 질문
  await page.click('button[data-action="go-done"]');
  await page.waitForSelector('button[data-action="prep"]');
  assert.equal(await page.locator('.final').count(), 2);
  await page.click('button[data-action="prep"]');
  await page.waitForSelector('.prep-q', { timeout: 15000 });
  assert.equal(await page.locator('.prep-q').count(), 2);
  await shot('06-done');
  step('완성 화면 + 면접 예상 질문');

  // 새로고침 후 상태 유지
  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForSelector('.final');
  assert.equal(await page.locator('.final').count(), 2);
  assert.equal(await page.locator('.prep-q').count(), 2);
  assert.equal(await page.locator('#side .exp').count(), 2);
  step('새로고침 후 localStorage 복원');

  // 가져오기: 악성 첨삭 값·깨진 프로필이 렌더링을 깨거나 스크립트를 실행하지 못해야 한다
  const badJson = JSON.stringify({ project: {
    profile: { company: 'x', jobPosting: null, jdSummary: 'nope' },
    questions: [{ id: 'q2', text: 'A', limit: 500 }, { text: 'B', mode: 'constructor' }],
    answers: { q2: { versions: [{ id: 'v1', text: 'hi', critique: { total: '<img src=x onerror="window.__xss=1">', must_fix: [], issues: [], strengths: [], scores: {} } }], currentVersionId: 'v1' } },
    step: 'write', prep: { questions: 'str' }, interview: { transcript: [null] },
  } });
  await page.evaluate((json) => { const f = new File([json], 'p.json', { type: 'application/json' }); const dt = new DataTransfer(); dt.items.add(f); const input = document.querySelector('#import-file'); input.files = dt.files; input.dispatchEvent(new Event('change', { bubbles: true })); }, badJson);
  await page.waitForFunction(() => window.__jaso.state.project.profile.company === 'x', null, { timeout: 5000 });
  assert.equal(await page.evaluate(() => window.__xss), undefined, 'XSS 실행되지 않음');
  const imported = await page.evaluate(() => { const p = window.__jaso.state.project; return { ids: p.questions.map((q) => q.id), modes: p.questions.map((q) => q.mode), crit: p.answers.q2?.versions[0]?.critique, jd: p.profile.jdSummary, jobPosting: p.profile.jobPosting }; });
  assert.deepEqual(imported.ids, ['q2', 'q3'], '충돌 없는 문항 id');
  assert.deepEqual(imported.modes, ['with', 'with']);
  assert.equal(imported.crit, null, '깨진 첨삭은 버림');
  assert.equal(imported.jd, null);
  assert.equal(imported.jobPosting, '');
  assert.equal(await page.locator('.answer-card').count(), 2);
  step('악성·불완전 JSON 가져오기 방어');

  // 사용량 표시
  const usage = await page.locator('#side .usage').textContent();
  assert.match(usage, /호출\s*\d+/);
  assert.match(usage, /\$\d+\.\d{3}/);

  // 모바일 뷰 렌더링 확인
  await page.setViewportSize({ width: 390, height: 844 });
  await page.evaluate(() => window.__jaso.actions['go-step']({ dataset: { step: 'write' } }));
  await shot('07-mobile-write');
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1);
  assert.equal(overflow, false, '모바일 가로 스크롤 없음');
  step('모바일 레이아웃');

  assert.deepEqual(consoleErrors, [], `콘솔 오류: ${consoleErrors.join(' | ')}`);
  console.log(`\nE2E 통과. API 호출 ${apiRequests.length}회 (인터뷰 ${mock.counters.interview}, 작성 ${mock.counters.writer}, 첨삭 ${mock.counters.critic}, 공고 ${mock.counters.jd}, 면접 ${mock.counters.prep}). 스크린샷: ${SHOTS}`);
} catch (err) {
  await shot('99-failure').catch(() => {});
  console.error('E2E 실패:', err);
  console.error('console errors:', consoleErrors);
  try {
    const diag = await page.evaluate(() => ({
      busy: window.__jaso?.state.ui.busy,
      pills: [...document.querySelectorAll('.answer-card > .card-head .pill')].map((p) => p.textContent),
      allPills: [...document.querySelectorAll('.pill')].map((p) => p.className + ':' + p.textContent),
      toasts: [...document.querySelectorAll('.toast')].map((t) => t.textContent),
      answers: Object.fromEntries(Object.entries(window.__jaso?.state.project.answers ?? {}).map(([k, a]) => [k, { status: a.status, error: a.error, versions: a.versions.map((v) => v.label) }])),
    }));
    console.error('diag:', JSON.stringify(diag, null, 1));
  } catch (e) { console.error('diag failed', e.message); }
  console.error('mock log:', JSON.stringify(mock.log.slice(-6), null, 1));
  process.exitCode = 1;
} finally {
  await browser.close();
  server.close();
}
