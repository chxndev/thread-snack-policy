// 아티팩트 모드 E2E: dist/artifact.html을 골격에 감싸 서빙하고, 가짜 window.claude(sample/downloads)로 전체 흐름을 검증한다.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '../../jaso');
const SHOTS = process.env.E2E_SHOTS || path.resolve(HERE, '../../.playwright');
fs.mkdirSync(SHOTS, { recursive: true });
const artifactHtml = fs.readFileSync(path.join(ROOT, 'dist', 'artifact.html'), 'utf8');
assert.ok(!/<!doctype|<html[\s>]|<head[\s>]|<body[\s>]/i.test(artifactHtml), '아티팩트 페이지는 골격 태그를 포함하지 않아야 함');
assert.ok(!/importmap|anthropic-sdk/.test(artifactHtml), '아티팩트 페이지는 SDK 번들·import map을 포함하지 않아야 함');
const MIME = { '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8' };

const server = http.createServer((req, res) => {
  const p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  if (p === '/' || p === '/index.html') {
    // 아티팩트 도구가 씌우는 골격과 같은 형태
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(`<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"><style>:root{color-scheme:light}body{margin:0;font:14px system-ui}[hidden]{display:none!important}</style></head><body>${artifactHtml}</body></html>`);
    return;
  }
  if (p.startsWith('/src/')) {
    const file = path.join(ROOT, p);
    if (file.startsWith(ROOT) && fs.existsSync(file)) { res.writeHead(200, { 'content-type': MIME[path.extname(file)] ?? 'application/octet-stream' }); fs.createReadStream(file).pipe(res); return; }
  }
  res.writeHead(404); res.end('not found');
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}/`;

const browser = await chromium.launch();
const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, locale: 'ko-KR' });
await context.addInitScript({ path: path.join(HERE, 'fake-claude.js') });
const page = await context.newPage();
const consoleErrors = [];
const requests = [];
page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()); });
page.on('pageerror', (e) => consoleErrors.push(`pageerror: ${e.message}`));
page.on('request', (r) => requests.push(r.url()));
const shot = (name) => page.screenshot({ path: path.join(SHOTS, `${name}.png`), fullPage: true });
const step = (name) => console.log(`✓ ${name}`);

try {
  await page.goto(base, { waitUntil: 'networkidle' });
  await page.waitForSelector('#f-company');
  assert.equal(await page.locator('#runtime-badge').textContent(), 'claude.ai 구독');
  await page.waitForFunction(() => window.__jaso && !document.querySelector('#stage .notice.info'), null, { timeout: 15000 });
  assert.equal(await page.locator('#stage .notice:has-text("API 키")').count(), 0, 'API 키 안내가 없어야 함');
  step('아티팩트 모드 부팅 (sample 연결)');

  await page.click('#btn-settings');
  assert.equal(await page.locator('#s-apikey').isVisible(), false, 'API 키 입력은 숨김');
  assert.equal(await page.locator('#s-tier').isVisible(), true, '모델 등급 선택 표시');
  await page.selectOption('#s-tier', 'complex');
  await page.click('#settings-form button[type=submit]');
  await page.waitForFunction(() => !document.querySelector('#settings-dialog').open);
  step('설정: 구독 모드 UI');

  await page.fill('#f-company', '네이버');
  await page.fill('#f-role', '백엔드 개발');
  await page.fill('#f-jd', '[네이버 백엔드 신입 채용] 자격요건: Java/Spring. 자소서 문항 1. 지원 동기(1000자) 2. 협업 갈등(700자)');
  await page.click('button[data-action="analyze-jd"]');
  await page.waitForSelector('.q-row', { timeout: 15000 });
  assert.equal(await page.locator('.q-row').count(), 2);
  step('공고 분석 (sample.json)');

  await page.click('button[data-action="start-interview"]');
  await page.waitForSelector('#iv-answer:not([disabled])', { timeout: 15000 });
  assert.match(await page.locator('.msg.agent').first().textContent(), /경험 후보를 2~3개/);
  await page.fill('#iv-answer', '캡스톤 프로젝트에서 API 성능을 개선했습니다.');
  await page.click('button[data-action="iv-send"]');
  await page.waitForFunction(() => document.querySelectorAll('.msg.agent:not(.streaming)').length >= 2, null, { timeout: 15000 });
  await page.waitForSelector('#iv-answer:not([disabled])');
  assert.equal(await page.locator('#side .exp').count(), 1);
  await page.fill('#iv-answer', '기능 중복으로 다툰 적이 있어요.');
  await page.click('button[data-action="iv-send"]');
  await page.waitForSelector('button[data-action="go-write"]', { timeout: 15000 });
  assert.equal(await page.locator('#side .exp').count(), 2);
  const ivCalls = await page.evaluate(() => window.__fakeCalls.filter((c) => c.turns > 0));
  assert.equal(ivCalls.length, 3);
  assert.ok(ivCalls.every((c) => c.kind === 'json' && c.cache === false && c.tier === 'default'));
  await shot('a1-artifact-interview');
  step('인터뷰 3턴 (JSON 턴, 저장 결과 전달)');

  await page.click('button[data-action="go-write"]');
  await page.click('button[data-action="write-all"]');
  await page.waitForFunction(() => {
    const pills = [...document.querySelectorAll('.answer-card > .card-head .pill')];
    return pills.length >= 2 && !document.querySelector('.pill.busy') && pills.every((p) => /첨삭 \d+점/.test(p.textContent));
  }, null, { timeout: 60000 });
  const q1 = await page.inputValue('#answer-q1');
  assert.match(q1, /입사 후 2년 안에는/);
  const writerCalls = await page.evaluate(() => window.__fakeCalls.filter((c) => c.kind === 'text'));
  assert.ok(writerCalls.length >= 4 && writerCalls.some((c) => c.tier === 'complex'), '작성은 complex 등급');
  assert.match(await page.locator('#side').textContent(), /사용량 \(claude\.ai 구독\)/);
  await shot('a2-artifact-write');
  step('작성·첨삭 파이프라인 (sample text/json)');

  await page.click('button[data-action="go-done"]');
  await page.click('button[data-action="prep"]');
  await page.waitForSelector('.prep-q', { timeout: 15000 });
  await page.click('button[data-action="download-txt"]');
  await page.waitForFunction(() => window.__saved, null, { timeout: 5000 });
  const saved = await page.evaluate(() => window.__saved);
  assert.match(saved.filename, /자기소개서\.txt$/);
  assert.ok(saved.size > 200);
  step('완성: 면접 질문 + downloads 기능으로 저장');

  // 페이지 내 확인 대화상자 (뷰어는 confirm()을 지원하지 않음)
  await page.click('#btn-project');
  await page.click('button[data-action="new-project"]');
  await page.waitForFunction(() => document.querySelector('#confirm-dialog').open);
  await page.click('button[data-action="confirm-cancel"]');
  await page.waitForFunction(() => !document.querySelector('#confirm-dialog').open);
  assert.equal(await page.evaluate(() => window.__jaso.state.project.questions.length), 2, '취소하면 유지');
  await page.click('#btn-project');
  await page.click('button[data-action="new-project"]');
  await page.waitForFunction(() => document.querySelector('#confirm-dialog').open);
  await page.click('#confirm-ok');
  await page.waitForFunction(() => window.__jaso.state.project.questions.length === 0);
  step('페이지 내 확인 대화상자');

  assert.ok(!requests.some((u) => /anthropic-sdk|api\.anthropic\.com/.test(u)), 'SDK 번들·API 요청 없음');
  assert.deepEqual(consoleErrors, [], `콘솔 오류: ${consoleErrors.join(' | ')}`);
  const c = await page.evaluate(() => window.__fakeCounters);
  console.log(`\nE2E(아티팩트) 통과. sample 호출: 인터뷰 ${c.interview}, 작성 ${c.writer}, 첨삭 ${c.critic}, 공고 ${c.jd}, 면접 ${c.prep}.`);
} catch (err) {
  await shot('a9-artifact-failure').catch(() => {});
  console.error('E2E(아티팩트) 실패:', err);
  console.error('console errors:', consoleErrors);
  try { console.error('calls:', JSON.stringify(await page.evaluate(() => window.__fakeCalls.slice(-6)))); } catch {}
  process.exitCode = 1;
} finally {
  await browser.close();
  server.close();
}
