// 2단계 E2E: 실제 jaso 서버(jaso/server/server.mjs)를 가짜 claude CLI로 띄우고 Playwright Chromium으로 검증한다.
//  1) PWA: manifest(application/manifest+json)·아이콘 200·<link rel=manifest>, dist/artifact.html 에는 manifest 마크업 없음
//  2) 기기 간 동기화: A 새 코드 → 공고 분석 → push(서버에는 암호문만) → B 같은 코드로 가져오기 → B 편집 → A가 visibilitychange·sync-now 로 받기
//     → 동시 편집 412 충돌 확인 대화상자 → 틀린 코드(C) 토스트 → 동기화 끄기 + 서버 사본 삭제
//  3) 폰(390×844, isMobile): 지원 정보·인터뷰·작성·완성 화면의 하단 동작 바가 화면 안, 가로 넘침 없음, 스크린샷 .playwright/m1-*.png
//  4) 텔레메트리 가드: 본문 수집을 켠 remote-settings.json 이 있는 서버 → 차단 안내 + 공고 분석이 telemetry_blocked 토스트(CLI 미실행)
//     → 캐시 파일을 고치면 재검사로 풀린다
// 실제 `claude` 바이너리나 네트워크 API는 쓰지 않는다. 서버마다 임시 HOME·설정 폴더·데이터 폴더를 쓴다.
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
const ARTIFACT = path.join(REPO, 'jaso', 'dist', 'artifact.html');
const SHOTS = process.env.E2E_SHOTS || path.join(REPO, '.playwright');
fs.mkdirSync(SHOTS, { recursive: true });
const KEY = 'e2e-sync-key-456';
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'jaso-e2e-sync-'));
const JD = '[네이버 백엔드 신입 채용] 자격요건: Java/Spring. 자소서 문항 1. 지원 동기(1000자) 2. 협업 갈등(700자)';
const TELEMETRY_NOTICE = '본문 수집을 켜 두어 지금은 작성할 수 없습니다';
const TELEMETRY_TOAST = '텔레메트리 설정이 프롬프트·답변 본문 수집을 켜 두어 호출을 중단했습니다';
const step = (name) => console.log(`✓ ${name}`);

// ───────────── 서버 (JASO_PORT=0 → stdout 의 listening 줄에서 포트를 읽는다) ─────────────
const servers = [];

/** 이름별 임시 폴더(home·claude 설정·데이터·작업)로 서버를 띄운다. files 는 { 'claude/remote-settings.json': 내용 } */
async function startServer(name, { env = {}, files = {} } = {}) {
  const dir = path.join(TMP, name);
  const s = {
    name, dir,
    home: path.join(dir, 'home'),
    configDir: path.join(dir, 'claude'),
    dataDir: path.join(dir, 'data', 'sync'), // 서버가 0700 으로 만든다
    fakeLog: path.join(dir, 'fake-calls.log'),
    log: '',
  };
  fs.mkdirSync(s.home, { recursive: true });
  fs.mkdirSync(s.configDir, { recursive: true });
  for (const [rel, content] of Object.entries(files)) fs.writeFileSync(path.join(dir, rel), content);
  const serverEnv = {
    PATH: process.env.PATH, HOME: s.home, LANG: process.env.LANG ?? 'C.UTF-8',
    JASO_PORT: '0', JASO_HOST: '127.0.0.1', JASO_ACCESS_KEY: KEY, JASO_CLAUDE_BIN: FAKE_CLI, JASO_LOGIN_PROBE: '0',
    JASO_WORK_DIR: path.join(dir, 'work'),
    // 운영자의 실제 ~/.claude 와 /etc/claude-code 를 읽지 않도록 가드가 볼 곳을 임시 폴더로 고정한다
    JASO_CLAUDE_CONFIG_DIR: s.configDir,
    JASO_MANAGED_SETTINGS_FILE: path.join(dir, 'managed-settings.json'), // 없음
    JASO_DATA_DIR: s.dataDir,
    // 가짜 CLI에는 호출 기록 파일과 두뇌 상태 파일(호출마다 새 프로세스라 인터뷰 턴·첨삭 번갈이를 이어 가기 위해)만 넘긴다
    JASO_CHILD_ENV_PASSTHROUGH: 'FAKE_LOG,FAKE_STATE', FAKE_LOG: s.fakeLog, FAKE_STATE: path.join(dir, 'fake-brain-state.json'),
    ...env,
  };
  s.proc = spawn(process.execPath, [SERVER], { env: serverEnv, stdio: ['ignore', 'pipe', 'pipe'] });
  servers.push(s);
  s.proc.stderr.on('data', (d) => { s.log += d; });
  s.base = await new Promise((resolve, reject) => {
    let out = '';
    const timer = setTimeout(() => reject(new Error(`[${name}] 서버가 15초 안에 시작되지 않음\n${s.log}`)), 15000);
    s.proc.stdout.on('data', (d) => {
      out += d;
      const m = /jaso server listening on (http:\/\/127\.0\.0\.1:\d+\/)\n/.exec(out);
      if (m) { clearTimeout(timer); resolve(m[1]); }
    });
    s.proc.once('exit', (code) => { clearTimeout(timer); reject(new Error(`[${name}] 서버가 먼저 종료됨 code=${code}\n${s.log}`)); });
  });
  s.health = async () => (await fetch(`${s.base}api/health`)).json();
  s.fakeCalls = () => { try { return fs.readFileSync(s.fakeLog, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; } };
  s.syncFiles = () => { try { return fs.readdirSync(s.dataDir).filter((f) => f.endsWith('.json')); } catch { return []; } };
  return s;
}

function stopServer(s) {
  return new Promise((resolve) => {
    const p = s.proc;
    if (!p || p.exitCode !== null || p.signalCode !== null) return resolve(p?.exitCode ?? null);
    const t = setTimeout(() => p.kill('SIGKILL'), 8000);
    p.once('exit', (code) => { clearTimeout(t); resolve(code); });
    p.kill('SIGTERM');
  });
}

const waitFor = async (fn, { timeout = 10000, interval = 100, what = '조건' } = {}) => {
  const end = Date.now() + timeout;
  let last;
  while (Date.now() < end) {
    last = await fn();
    if (last) return last;
    await new Promise((r) => setTimeout(r, interval));
  }
  throw new Error(`${what}: ${timeout}ms 안에 만족하지 않음 (마지막 값 ${JSON.stringify(last)})`);
};

// ───────────── 브라우저 도우미 ─────────────
const consoleErrors = [];
const pages = {};

/** 콘솔 오류를 모은다. allow 는 이 페이지에서 일부러 일으키는 리소스 상태 코드(예: 412 충돌, 404 틀린 코드) */
function watch(page, tag, allow = []) {
  pages[tag] = page;
  const allowed = allow.length ? new RegExp(`Failed to load resource: .*\\b(${allow.join('|')})\\b`) : null;
  page.on('console', (m) => { if (m.type() === 'error' && !(allowed && allowed.test(m.text()))) consoleErrors.push(`[${tag}] ${m.text()}`); });
  page.on('pageerror', (e) => consoleErrors.push(`[${tag}] pageerror: ${e.message}`));
  return page;
}
const ready = (page) => page.waitForFunction(() => window.__jaso && window.__jaso.runtime.checking === false, null, { timeout: 10000 });
const syncState = (page) => page.evaluate(() => ({ ...window.__jaso.state.sync, syncBusy: window.__jaso.state.ui.syncBusy, syncError: window.__jaso.state.ui.syncError, updatedAt: window.__jaso.state.project.updatedAt }));
const toastTexts = (page) => page.locator('#toast .toast').allTextContents();
const waitToast = (page, text, timeout = 10000) => page.waitForFunction((t) => [...document.querySelectorAll('#toast .toast')].some((el) => el.textContent.includes(t)), text, { timeout });
/** 지금 프로젝트 버전이 서버에 올라갈 때까지 (lastPushedAt 이 after 보다 커지고 baseUpdatedAt 이 현재 버전) */
const waitPushed = (page, after, timeout = 15000) => page.waitForFunction((t) => {
  const s = window.__jaso.state;
  return s.sync.lastPushedAt > t && s.sync.baseUpdatedAt === s.project.updatedAt && !s.ui.syncBusy && !s.ui.busy;
}, after, { timeout });
const openSettings = async (page) => {
  await page.click('#btn-settings');
  await page.waitForFunction(() => document.querySelector('#settings-dialog').open);
};
const submitSettings = async (page) => {
  await page.click('#settings-form button[type=submit]');
  await page.waitForFunction(() => !document.querySelector('#settings-dialog').open);
};
const withAccessKey = (ctx) => ctx.addInitScript((k) => { try { if (!localStorage.getItem('jaso.accessKey.v1')) localStorage.setItem('jaso.accessKey.v1', JSON.stringify(k)); } catch { /* 무시 */ } }, KEY);

/** 폰 화면 측정: 동작 바 위치, 가로 넘침, 16px 미만 입력란, 44px 미만 동작 바 버튼 */
const measure = (page) => page.evaluate(() => {
  const bar = document.querySelector('#stage .actionbar');
  const r = bar?.getBoundingClientRect();
  const visible = (el) => !!el.offsetParent && getComputedStyle(el).visibility !== 'hidden';
  return {
    innerWidth, innerHeight,
    scrollWidth: document.documentElement.scrollWidth,
    bar: bar && visible(bar) ? { top: Math.round(r.top), bottom: Math.round(r.bottom), left: Math.round(r.left), right: Math.round(r.right) } : null,
    barSmall: bar ? [...bar.querySelectorAll('.btn')].filter((b) => visible(b) && b.getBoundingClientRect().height < 44).map((b) => b.textContent.trim()) : [],
    smallInputs: [...document.querySelectorAll('input, textarea, select')].filter((e) => visible(e) && parseFloat(getComputedStyle(e).fontSize) < 16).map((e) => e.id || e.name || e.className),
    wide: [...document.querySelectorAll('body *')].filter((el) => el.getBoundingClientRect().right > innerWidth + 0.5 && getComputedStyle(el).position !== 'fixed').slice(0, 5).map((el) => `${el.tagName.toLowerCase()}#${el.id}.${el.className}`),
  };
});
function assertPhoneLayout(m, label, { bar = true } = {}) {
  assert.ok(m.scrollWidth <= m.innerWidth, `[${label}] 가로 넘침 ${m.scrollWidth} > ${m.innerWidth}: ${m.wide.join(', ')}`);
  assert.deepEqual(m.smallInputs, [], `[${label}] 16px 미만 입력란(iOS 확대)`);
  if (bar) {
    assert.ok(m.bar, `[${label}] 하단 동작 바가 보여야 함`);
    assert.ok(m.bar.bottom <= m.innerHeight && m.bar.top >= 0, `[${label}] 동작 바가 화면 안에 있어야 함 ${JSON.stringify(m.bar)} / ${m.innerHeight}`);
    assert.ok(m.bar.left >= 0 && m.bar.right <= m.innerWidth, `[${label}] 동작 바 가로 ${JSON.stringify(m.bar)}`);
    assert.deepEqual(m.barSmall, [], `[${label}] 동작 바 버튼은 44px 이상`);
  }
}

/** PNG 의 IHDR 에서 가로·세로 */
const pngSize = (buf) => ({ sig: buf.subarray(0, 8).toString('hex'), w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) });

const browser = await chromium.launch();
let A; let T;
try {
  A = await startServer('main');

  // ═════════════ 1. PWA: manifest·아이콘·head 마크업 ═════════════
  const health = await A.health();
  assert.equal(health.runtime, 'server');
  assert.deepEqual(
    { mode: health.telemetry?.mode, status: health.telemetry?.status, flags: health.telemetry?.flags, remoteManaged: health.telemetry?.remoteManaged, cacheFile: health.telemetry?.cacheFile },
    { mode: 'block', status: 'clear', flags: [], remoteManaged: 'none', cacheFile: 'absent' },
    `telemetry: ${JSON.stringify(health.telemetry)}`,
  );
  assert.ok(health.telemetry.checkedAt, '첫 검사 시각');
  assert.deepEqual(health.sync, { enabled: true, items: 0, maxBytes: 2097152 });
  assert.ok(!JSON.stringify(health).includes(TMP), 'health 에 운영자 경로가 없어야 함');
  assert.equal((fs.statSync(A.dataDir).mode & 0o777).toString(8), '700', '동기화 데이터 폴더 0700');

  const manRes = await fetch(`${A.base}jaso/manifest.webmanifest`);
  assert.equal(manRes.status, 200);
  assert.match(manRes.headers.get('content-type') ?? '', /^application\/manifest\+json/);
  const manifest = await manRes.json();
  assert.equal(manifest.name, '자소서 에이전트');
  assert.equal(manifest.short_name, '자소서');
  assert.equal(manifest.display, 'standalone');
  assert.equal(manifest.start_url, './');
  assert.equal(manifest.lang, 'ko');
  assert.ok(manifest.icons.some((i) => i.purpose === 'maskable' && i.sizes === '512x512'), '512 maskable 아이콘');
  const iconChecks = [...manifest.icons.map((i) => ({ src: i.src, sizes: i.sizes })), { src: 'icons/icon-180.png', sizes: '180x180' }];
  for (const { src, sizes } of iconChecks) {
    const r = await fetch(new URL(src, `${A.base}jaso/manifest.webmanifest`));
    assert.equal(r.status, 200, src);
    assert.equal(r.headers.get('content-type'), 'image/png', src);
    const { sig, w, h } = pngSize(Buffer.from(await r.arrayBuffer()));
    assert.equal(sig, '89504e470d0a1a0a', `${src} PNG 서명`);
    assert.equal(`${w}x${h}`, sizes, `${src} 크기`);
  }
  const svg = await fetch(`${A.base}jaso/icons/icon.svg`);
  assert.equal(svg.status, 200);
  assert.match(svg.headers.get('content-type') ?? '', /^image\/svg\+xml/);
  const indexHtml = await (await fetch(`${A.base}jaso/index.html`)).text();
  assert.match(indexHtml, /<link rel="manifest" href="\.\/manifest\.webmanifest">/);
  assert.match(indexHtml, /<link rel="apple-touch-icon" href="\.\/icons\/icon-180\.png">/);
  assert.match(indexHtml, /<meta name="theme-color"[^>]*prefers-color-scheme: dark/);
  assert.match(indexHtml, /viewport-fit=cover/);
  const artifact = fs.readFileSync(ARTIFACT, 'utf8');
  for (const re of [/rel=["']?manifest/i, /manifest\.webmanifest/, /apple-touch-icon/, /name=["']?theme-color/, /icons\/icon-/, /mobile-web-app-capable/]) {
    assert.ok(!re.test(artifact), `dist/artifact.html 에 PWA 마크업이 없어야 함: ${re}`);
  }
  assert.ok(artifact.includes('id="s-sync-block"'), '아티팩트에도 본문 마크업(숨김)은 그대로');
  step('PWA: manifest(application/manifest+json)·아이콘 4종 PNG 크기·SVG, head 마크업, 아티팩트에는 manifest 마크업 없음');

  // ═════════════ 2. 기기 간 동기화 (A·B·C 는 서로 다른 저장소의 브라우저 컨텍스트) ═════════════
  const desktop = { viewport: { width: 1280, height: 900 }, locale: 'ko-KR' };
  const ctxA = await browser.newContext(desktop);
  const pa = watch(await ctxA.newPage(), 'A', ['412']); // 동시 편집 충돌의 412 는 If-Match 프로토콜상 브라우저가 콘솔에 찍는다
  const aSyncRequests = [];
  pa.on('request', (r) => { if (r.url().includes('/api/sync/')) aSyncRequests.push(`${r.method()} ${r.url().replace(/^.*\/api\/sync\//, '')}`); });
  await pa.goto(`${A.base}jaso/`, { waitUntil: 'networkidle' });
  await ready(pa);
  assert.equal(await pa.locator('#runtime-badge').textContent(), '운영자 구독');
  assert.equal(await pa.evaluate(() => document.querySelector('link[rel="manifest"]')?.href), `${A.base}jaso/manifest.webmanifest`);
  assert.match(await pa.locator('#side').textContent(), /동기화: 꺼짐/);
  assert.match(await pa.locator('#side').textContent(), /조직 텔레메트리: 본문 수집 꺼짐 확인 \(\d\d:\d\d\)/);
  assert.equal(await pa.locator('#stage .actionbar').count(), 1, '동작 바는 그려지지만');
  assert.equal(await pa.locator('#stage .actionbar').isVisible(), false, '데스크톱에서는 숨김');

  await openSettings(pa);
  assert.equal(await pa.locator('#s-sync-block').isVisible(), true, '서버 모드: 동기화 블록 표시');
  assert.match(await pa.locator('#s-sync-block').textContent(), /서버에는 암호화된 상태로만 저장됩니다/);
  await pa.fill('#s-accesskey', KEY);
  await pa.click('button[data-action="sync-new-code"]');
  await pa.waitForFunction(() => window.__jaso.state.sync.enabled && window.__jaso.state.sync.lastPushedAt > 0, null, { timeout: 10000 });
  const code = await pa.evaluate(() => window.__jaso.state.sync.code);
  assert.match(code, /^jaso(-[a-hjkmnp-z2-9]{4}){4}$/, `코드 형식: ${code}`);
  assert.equal(await pa.inputValue('#s-synccode'), code);
  await submitSettings(pa);
  assert.equal((await A.health()).sync.items, 1);
  assert.match(await pa.locator('#sync-status').textContent(), /동기화: 켜짐 · 마지막 \d\d:\d\d/);
  await waitToast(pa, '새 동기화 코드를 만들어');
  step(`A: 새 동기화 코드(${code.slice(0, 9)}…) → 빈 프로젝트 push, 사이드바 '동기화: 켜짐'`);

  // A: 공고 분석 → 문항 2개 → 끝나면 debounce 뒤 push
  const aPushed0 = (await syncState(pa)).lastPushedAt;
  await pa.fill('#f-company', '네이버');
  await pa.fill('#f-role', '백엔드 개발');
  await pa.fill('#f-jd', JD);
  await pa.click('button[data-action="analyze-jd"]');
  await pa.waitForSelector('.q-row', { timeout: 15000 });
  assert.equal(await pa.locator('.q-row').count(), 2);
  await waitPushed(pa, aPushed0);
  const sA = await syncState(pa);
  assert.equal(A.fakeCalls().length, 1, '공고 분석 CLI 1회');

  // 서버에는 암호문만: 파일 하나, 평문(회사명·직무·공고) 없음, payload 는 v1 바이트로 시작하는 base64url
  const files = A.syncFiles();
  assert.deepEqual(files, [`${sA.id}.json`]);
  const rawRecord = fs.readFileSync(path.join(A.dataDir, files[0]), 'utf8');
  const record = JSON.parse(rawRecord);
  assert.deepEqual(Object.keys(record).sort(), ['bytes', 'etag', 'id', 'payload', 'storedAt', 'updatedAt']);
  assert.equal(record.etag, sA.etag);
  assert.equal(record.updatedAt, sA.updatedAt);
  assert.match(record.payload, /^[A-Za-z0-9_-]+$/);
  const decoded = Buffer.from(record.payload, 'base64url');
  assert.equal(decoded[0], 1, 'v1 바이트');
  for (const plain of ['네이버', '백엔드', 'Java/Spring', '지원 동기']) {
    assert.ok(!rawRecord.includes(plain) && !decoded.includes(Buffer.from(plain)), `서버 저장본에 평문 '${plain}'이 없어야 함`);
  }
  assert.equal((fs.statSync(path.join(A.dataDir, files[0])).mode & 0o077), 0, '레코드 파일은 소유자만');
  const direct = await fetch(`${A.base}api/sync/${sA.id}`, { headers: { authorization: `Bearer ${KEY}` } });
  assert.equal(direct.status, 200);
  assert.equal(direct.headers.get('etag'), `"${sA.etag}"`);
  step('A: 공고 분석(문항 2개) → push, 서버 파일은 암호문만(평문 없음, 0600), ETag 일치');

  // B: 새 저장소에서 같은 코드(대문자·공백으로 입력)를 넣으면 서버 버전을 가져온다
  const ctxB = await browser.newContext(desktop);
  const pb = watch(await ctxB.newPage(), 'B', ['404']); // 끝에서 A 가 서버 사본을 지운 뒤 B 의 pull 은 404 를 받는다
  await pb.goto(`${A.base}jaso/`, { waitUntil: 'networkidle' });
  await ready(pb);
  assert.equal(await pb.locator('.q-row').count(), 0, 'B 는 빈 프로젝트로 시작');
  await openSettings(pb);
  await pb.fill('#s-accesskey', KEY);
  await pb.fill('#s-synccode', code.toUpperCase().replace(/-/g, ' '));
  await submitSettings(pb);
  await pb.waitForFunction(() => window.__jaso.state.sync.enabled && window.__jaso.state.project.questions.length === 2 && !window.__jaso.state.ui.syncBusy, null, { timeout: 15000 });
  await waitToast(pb, '서버의 프로젝트를 가져왔습니다');
  assert.equal(await pb.locator('.q-row').count(), 2);
  assert.equal(await pb.inputValue('#f-company'), '네이버');
  const sB0 = await syncState(pb);
  assert.equal(sB0.code, code, '입력한 코드를 정규형으로 저장');
  assert.equal(sB0.id, sA.id);
  assert.equal(sB0.etag, sA.etag);
  step('B: 같은 코드(대문자·공백 입력) → 서버 버전 가져오기, 문항 2개');

  // B 가 회사명을 고치면 push → A 는 탭이 다시 보일 때(visibilitychange) 가져온다
  await pb.fill('#f-company', '카카오');
  await waitPushed(pb, sB0.lastPushedAt);
  const sB1 = await syncState(pb);
  assert.notEqual(sB1.etag, sA.etag);
  const aGetsBefore = aSyncRequests.filter((r) => r.startsWith('GET')).length;
  await pa.evaluate(() => {
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => false });
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await pa.waitForFunction(() => window.__jaso.state.project.profile.company === '카카오' && !window.__jaso.state.ui.syncBusy, null, { timeout: 10000 });
  assert.equal(await pa.inputValue('#f-company'), '카카오', '화면도 다시 그려짐');
  await waitToast(pa, '다른 기기의 변경을 가져왔습니다');
  assert.equal(aSyncRequests.filter((r) => r.startsWith('GET')).length, aGetsBefore + 1, `visibilitychange 로 GET 1회: ${aSyncRequests.join(', ')}`);
  assert.equal((await syncState(pa)).etag, sB1.etag);
  assert.equal(await pa.locator('.q-row').count(), 2);
  step('B: 회사명 수정 → push / A: visibilitychange → GET → 화면에 반영 + 토스트');

  // 두 번째 변경은 sync-now 동작으로 (visibilitychange 는 20초에 한 번으로 묶여 있다)
  await pb.fill('#f-role', '프론트엔드');
  await waitPushed(pb, sB1.lastPushedAt);
  const sB2 = await syncState(pb);
  assert.equal(await pa.evaluate(() => window.__jaso.actions['sync-now']()), 'pulled');
  assert.equal(await pa.inputValue('#f-role'), '프론트엔드');
  assert.equal(await pa.evaluate(() => window.__jaso.actions['sync-now']()), 'same', '바뀐 게 없으면 304 → same');
  assert.equal(await pb.evaluate(() => window.__jaso.actions['sync-now']()), 'same');
  step("B: 직무 수정 → A: sync-now → 'pulled', 다시 누르면 304 'same'");

  // 동시 편집: B 가 먼저 올리고, 아직 모르는 A 가 편집 → PUT If-Match 412 → 확인 대화상자 → 서버 버전 가져오기.
  // 이때 A 에는 다른 확인 질문이 이미 열려 있다 → 충돌 질문은 그 질문을 덮어쓰지 않고, 닫힌 뒤에 차례로 뜬다
  await pb.fill('#f-role', 'B버전 직무');
  await waitPushed(pb, sB2.lastPushedAt);
  const sB3 = await syncState(pb);
  const a412 = [];
  const on412 = (r) => { if (r.url().includes('/api/sync/') && r.request().method() === 'PUT' && r.status() === 412) a412.push(r.status()); };
  pa.on('response', on412);
  const firstQuestion = pa.evaluate(() => window.__jaso.actions['sync-new-code']()); // 동기화가 켜져 있으면 '새 코드를 만들면…' 을 묻는다
  await pa.waitForFunction(() => document.querySelector('#confirm-dialog').open && /새 코드를 만들면/.test(document.querySelector('#confirm-message').textContent));
  // 모달 뒤의 입력란은 inert 라 입력 이벤트를 직접 보내 편집한다 → 1.5초 뒤 push → 412
  await pa.evaluate(() => { const el = document.querySelector('#f-company'); el.value = 'A버전 회사'; el.dispatchEvent(new Event('input', { bubbles: true })); });
  await waitFor(() => a412.length > 0, { timeout: 10000, what: 'A 의 PUT 412' });
  await pa.waitForTimeout(300);
  assert.match(await pa.locator('#confirm-message').textContent(), /새 코드를 만들면/, '충돌 질문이 열려 있는 질문을 덮어쓰지 않는다');
  assert.equal(await pa.locator('#confirm-ok').textContent(), '새 코드 만들기');
  await pa.click('button[data-action="confirm-cancel"]');
  await firstQuestion;
  assert.equal((await syncState(pa)).code, sA.code, '취소했으니 새 코드를 만들지 않는다');
  await pa.waitForFunction(() => document.querySelector('#confirm-dialog').open && /다른 기기에서 바뀐 내용이 있습니다/.test(document.querySelector('#confirm-message').textContent), null, { timeout: 10000 });
  pa.off('response', on412);
  assert.equal(await pa.locator('#confirm-ok').textContent(), '서버 버전 가져오기');
  await pa.screenshot({ path: path.join(SHOTS, 'sync-a-conflict.png') });
  await pa.click('button[data-action="confirm-ok"]');
  await pa.waitForFunction(() => window.__jaso.state.project.profile.role === 'B버전 직무' && !window.__jaso.state.ui.syncBusy, null, { timeout: 10000 });
  assert.equal(await pa.inputValue('#f-company'), '카카오', 'A 의 편집 대신 서버(B) 버전');
  const sA2 = await syncState(pa);
  assert.equal(sA2.etag, sB3.etag);
  assert.equal(JSON.parse(fs.readFileSync(path.join(A.dataDir, files[0]), 'utf8')).etag, sB3.etag, '서버 기록은 B 버전 그대로');
  assert.ok(aSyncRequests.some((r) => r.startsWith('PUT')), 'A 가 PUT 을 시도함');
  step('동시 편집: A 의 PUT 이 412 → (열려 있던 질문이 닫힌 뒤) 확인 대화상자 → 서버 버전 가져오기 (서버 기록은 B 버전)');

  // C: 틀린 코드 → '동기화 코드가 맞지 않아' 토스트, 꺼진 상태 유지 / 형식 오류 → 형식 토스트
  const ctxC = await browser.newContext(desktop);
  const pc = watch(await ctxC.newPage(), 'C', ['404']); // 틀린 코드는 서버에서 '기록 없음'(404)으로 나타난다
  await withAccessKey(ctxC);
  await pc.goto(`${A.base}jaso/`, { waitUntil: 'networkidle' });
  await ready(pc);
  await openSettings(pc);
  assert.equal(await pc.inputValue('#s-accesskey'), KEY);
  await pc.fill('#s-synccode', 'jaso-aaaa-bbbb-cccc-dddd');
  await submitSettings(pc);
  await waitToast(pc, '동기화 코드가 맞지 않아');
  await pc.waitForFunction(() => !window.__jaso.state.ui.syncBusy);
  const sC = await syncState(pc);
  assert.equal(sC.enabled, false);
  assert.equal(sC.code, '');
  assert.match(await pc.locator('#sync-status').textContent(), /동기화: 꺼짐/);
  assert.equal((await A.health()).sync.items, 1, '틀린 코드는 서버에 새 기록을 만들지 않음');
  await openSettings(pc);
  await pc.fill('#s-synccode', 'jaso-1234');
  await submitSettings(pc);
  await waitToast(pc, '동기화 코드 형식이 올바르지 않습니다');
  assert.equal((await syncState(pc)).enabled, false);
  step("C: 틀린 코드 → '동기화 코드가 맞지 않아' 토스트·꺼짐 유지, 형식 오류 → 형식 토스트");

  // A: 동기화 끄기 + 서버 사본 삭제 → 서버 기록 0
  await openSettings(pa);
  await pa.click('button[data-action="sync-off"]');
  await pa.waitForSelector('#confirm-dialog[open]');
  assert.match(await pa.locator('#confirm-message').textContent(), /서버에 남아 있는 암호화된 사본도 삭제할까요\? 이 코드로 동기화가 켜져 있는 다른 기기는 다음 동기화 때 사본을 다시 올릴지 묻습니다/);
  await pa.click('button[data-action="confirm-ok"]');
  await waitToast(pa, '서버의 사본을 삭제했습니다');
  assert.deepEqual(await pa.evaluate(() => window.__jaso.state.sync), { code: '', id: '', etag: '', lastPushedAt: 0, lastPulledAt: 0, baseUpdatedAt: 0, enabled: false });
  assert.equal(await pa.evaluate(() => localStorage.getItem('jaso.sync.v1')), null, 'localStorage 의 동기화 상태도 지움');
  assert.equal(await pa.inputValue('#s-synccode'), '');
  await pa.click('button[data-action="close-settings"]');
  assert.equal((await A.health()).sync.items, 0);
  assert.deepEqual(A.syncFiles(), []);
  assert.equal(await pa.locator('.q-row').count(), 2, '이 기기의 내용은 그대로');
  // 아직 켜져 있는 B 가 동기화하면 몰래 다시 올리지 않고 묻는다 → 취소 → B 도 동기화를 끄고 서버는 비어 있는 채로
  const bPull = pb.evaluate(() => window.__jaso.actions['sync-now']());
  await pb.waitForFunction(() => document.querySelector('#confirm-dialog').open, null, { timeout: 10000 });
  assert.match(await pb.locator('#confirm-message').textContent(), /서버에 있던 이 코드의 동기화 사본이 없어졌습니다/);
  assert.equal(await pb.locator('#confirm-ok').textContent(), '다시 올리기');
  assert.equal((await A.health()).sync.items, 0, '묻는 동안에도 다시 만들지 않는다');
  await pb.click('button[data-action="confirm-cancel"]');
  assert.equal(await bPull, 'off');
  await waitToast(pb, '서버 사본이 없어 이 기기의 동기화를 껐습니다');
  assert.equal((await syncState(pb)).enabled, false);
  assert.match(await pb.locator('#sync-status').textContent(), /동기화: 꺼짐/);
  assert.equal(await pb.locator('.q-row').count(), 2, 'B 의 내용은 그대로');
  // B 가 옛 etag 로 PUT 해도(삭제를 모르는 기기의 편집) 서버는 412 sync_missing 으로 거절한다
  const stalePut = await fetch(`${A.base}api/sync/${sA.id}`, { method: 'PUT', headers: { authorization: `Bearer ${KEY}`, 'content-type': 'application/json', 'if-match': `"${sB3.etag}"` }, body: JSON.stringify({ payload: 'AQID', updatedAt: Date.now() }) });
  assert.equal(stalePut.status, 412); assert.equal((await stalePut.json()).code, 'sync_missing');
  assert.equal((await A.health()).sync.items, 0);
  assert.deepEqual(A.syncFiles(), []);
  step('A: 동기화 끄기 + 서버 사본 삭제 → 서버 기록 0, B 는 다시 올릴지 묻고 취소하면 B 도 꺼짐 (옛 etag PUT 은 412 sync_missing)');

  // 서버 로그: 동기화 경로는 경로 틀(:id)만, id·payload 는 남기지 않는다
  assert.match(A.log, /PUT \/api\/sync\/:id 200/);
  assert.match(A.log, /GET \/api\/sync\/:id 304/);
  assert.match(A.log, /PUT \/api\/sync\/:id 412/);
  assert.ok(!A.log.includes(sA.id), '서버 로그에 동기화 id 가 없어야 함');
  assert.ok(!A.log.includes(record.payload.slice(0, 24)), '서버 로그에 payload 가 없어야 함');
  step('서버 로그: /api/sync/:id 만 기록 (id·payload 없음)');
  await ctxA.close(); await ctxB.close(); await ctxC.close();

  // ═════════════ 3. 폰 화면 (390×844, isMobile, hasTouch, DPR 3) ═════════════
  const ctxM = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 3, locale: 'ko-KR', permissions: ['clipboard-read', 'clipboard-write'] });
  await withAccessKey(ctxM);
  const pm = watch(await ctxM.newPage(), 'M');
  await pm.goto(`${A.base}jaso/`, { waitUntil: 'networkidle' });
  await ready(pm);
  await pm.fill('#f-company', '네이버');
  await pm.fill('#f-role', '백엔드 개발');
  await pm.fill('#f-jd', JD);
  await pm.click('#stage button[data-action="analyze-jd"]');
  await pm.waitForFunction(() => document.querySelectorAll('.q-row').length === 2 && !window.__jaso.state.ui.busy, null, { timeout: 15000 });
  await pm.evaluate(() => window.scrollTo(0, 0));
  let m = await measure(pm);
  assertPhoneLayout(m, '지원 정보');
  assert.deepEqual(await pm.locator('#stage .actionbar [data-action]').evaluateAll((els) => els.map((e) => e.dataset.action)), ['skip-interview', 'start-interview']);
  await pm.screenshot({ path: path.join(SHOTS, 'm1-setup.png') });
  await pm.screenshot({ path: path.join(SHOTS, 'm1-setup-full.png'), fullPage: true });

  // 설정 대화상자: 폰에서는 전체 폭
  await openSettings(pm);
  const dlg = await pm.evaluate(() => { const r = document.querySelector('#settings-dialog').getBoundingClientRect(); return { left: r.left, right: r.right, w: innerWidth, sw: document.documentElement.scrollWidth }; });
  assert.ok(dlg.left <= 1 && dlg.right >= dlg.w - 1 && dlg.sw <= dlg.w, `설정 대화상자 전체 폭 ${JSON.stringify(dlg)}`);
  assert.equal(await pm.locator('#s-sync-block').isVisible(), true);
  assert.deepEqual((await measure(pm)).smallInputs, [], '대화상자 입력란도 16px 이상');
  // 설정 시트가 화면 아래를 덮어도 토스트는 그 위에 보여야 한다 (top layer 의 popover).
  // 모달이 열려 있으면 바깥 요소는 inert 라 elementFromPoint 로는 알 수 없으므로, 토스트 자리를 토스트가 있을 때/없을 때 찍어 비교한다
  await pm.fill('#s-synccode', 'jaso-aaaa-bbbb-cccc-dddd');
  await pm.click('#settings-dialog button[data-action="sync-copy-code"]');
  await waitToast(pm, '복사했습니다');
  const tbox = await pm.evaluate(() => {
    const t = [...document.querySelectorAll('#toast .toast')].at(-1).getBoundingClientRect();
    const d = document.querySelector('#settings-dialog').getBoundingClientRect();
    return { clip: { x: t.left, y: t.top, width: t.width, height: t.height }, underDialog: t.top >= d.top && t.bottom <= d.bottom, popover: document.querySelector('#toast').matches(':popover-open') };
  });
  assert.ok(tbox.underDialog, `토스트 자리가 설정 시트와 겹친다 ${JSON.stringify(tbox)}`);
  assert.equal(tbox.popover, true, '토스트 상자는 popover 로 떠 있다');
  const withToast = await pm.screenshot({ clip: tbox.clip, animations: 'disabled' });
  await pm.evaluate(() => { document.querySelector('#toast').style.visibility = 'hidden'; });
  const withoutToast = await pm.screenshot({ clip: tbox.clip, animations: 'disabled' });
  await pm.evaluate(() => { document.querySelector('#toast').style.visibility = ''; });
  assert.notEqual(Buffer.compare(withToast, withoutToast), 0, '토스트가 설정 시트 위에 그려져야 함(가려지면 두 사진이 같다)');
  await pm.screenshot({ path: path.join(SHOTS, 'm1-settings-toast.png') });
  await pm.evaluate(() => document.querySelectorAll('#toast .toast').forEach((e) => e.remove()));
  await pm.screenshot({ path: path.join(SHOTS, 'm1-settings.png') });
  await pm.click('button[data-action="close-settings"]');
  step(`폰 지원 정보: 동작 바 ${m.bar.top}–${m.bar.bottom}/${m.innerHeight}px, 가로 넘침 없음, 입력란 16px, 설정 대화상자 전체 폭, 토스트는 시트 위`);

  // 인터뷰: 동작 바의 버튼으로 시작 → 답변 대기 중에는 입력창이 화면 아래에 붙는다
  await pm.click('#stage .actionbar [data-action="start-interview"]');
  await pm.waitForSelector('#iv-answer:not([disabled])', { timeout: 15000 });
  m = await measure(pm);
  assertPhoneLayout(m, '인터뷰', { bar: false });
  assert.equal(m.bar, null, '답변 대기 중에는 동작 바 대신 입력창');
  const composer = await pm.evaluate(() => { const r = document.querySelector('#iv-answer').getBoundingClientRect(); return { top: Math.round(r.top), bottom: Math.round(r.bottom) }; });
  assert.ok(composer.bottom <= m.innerHeight + 1 && composer.top >= 0, `답변 입력창이 화면 안 ${JSON.stringify(composer)}`);
  await pm.screenshot({ path: path.join(SHOTS, 'm1-interview.png') });
  await pm.fill('#iv-answer', '캡스톤 프로젝트에서 API 성능을 개선했습니다.');
  await pm.click('button[data-action="iv-send"]');
  await pm.waitForFunction(() => document.querySelectorAll('.msg.agent:not(.streaming)').length >= 2 && !window.__jaso.state.ui.busy, null, { timeout: 15000 });
  await pm.waitForSelector('#iv-answer:not([disabled])');
  await pm.fill('#iv-answer', '기능 중복으로 다툰 적이 있어요.');
  await pm.click('button[data-action="iv-send"]');
  await pm.waitForSelector('#stage .actionbar [data-action="go-write"]', { timeout: 15000 });
  m = await measure(pm);
  assertPhoneLayout(m, '인터뷰 종료');
  step(`폰 인터뷰: 답변 입력창 ${composer.top}–${composer.bottom}/${m.innerHeight}px, 3턴 종료 후 동작 바에 '작성 단계로'`);

  // 작성: 동작 바로 이동 → 전체 작성 → 완성으로
  await pm.click('#stage .actionbar [data-action="go-write"]');
  await pm.waitForSelector('#stage .actionbar [data-action="write-all"]');
  await pm.evaluate(() => window.scrollTo(0, 0));
  m = await measure(pm);
  assertPhoneLayout(m, '작성');
  await pm.screenshot({ path: path.join(SHOTS, 'm1-write.png') });
  await pm.click('#stage .actionbar [data-action="write-all"]');
  await pm.waitForFunction(() => {
    const pills = [...document.querySelectorAll('.answer-card > .card-head .pill')];
    return !window.__jaso.state.ui.busy && pills.length >= 2 && !document.querySelector('.pill.busy') && pills.every((p) => /첨삭 \d+점/.test(p.textContent));
  }, null, { timeout: 60000 });
  m = await measure(pm);
  assertPhoneLayout(m, '작성 완료');
  await pm.screenshot({ path: path.join(SHOTS, 'm1-write-done.png') });
  await pm.click('#stage .actionbar [data-action="go-done"]');
  await pm.waitForFunction(() => document.querySelectorAll('.final').length === 2, null, { timeout: 10000 });
  await pm.evaluate(() => window.scrollTo(0, 0));
  m = await measure(pm);
  assertPhoneLayout(m, '완성');
  assert.deepEqual(await pm.locator('#stage .actionbar [data-action]').evaluateAll((els) => els.map((e) => e.dataset.action)), ['copy-all', 'download-txt']);
  await pm.screenshot({ path: path.join(SHOTS, 'm1-done.png') });
  await ctxM.close();
  step('폰 작성·완성: 동작 바로 전체 작성 → 완성, 각 화면 동작 바가 화면 안·가로 넘침 없음 (m1-*.png)');

  // ═════════════ 4. 텔레메트리 가드: 본문 수집을 켠 조직 설정 캐시가 있는 서버 ═════════════
  const blocking = { env: { OTEL_LOG_USER_PROMPTS: '1', OTEL_METRICS_EXPORTER: 'otlp', CLAUDE_CODE_ENABLE_TELEMETRY: '1' } };
  // 가짜 doctor 가 'Managed settings (remote): loaded' 를 찍도록 FAKE_REMOTE_MANAGED 도 자식 CLI 에 넘긴다
  T = await startServer('blocked', {
    files: { 'claude/remote-settings.json': JSON.stringify(blocking) },
    env: { FAKE_REMOTE_MANAGED: 'loaded', JASO_CHILD_ENV_PASSTHROUGH: 'FAKE_LOG,FAKE_STATE,FAKE_REMOTE_MANAGED' },
  });
  const th = await T.health();
  assert.deepEqual(
    { mode: th.telemetry.mode, status: th.telemetry.status, flags: th.telemetry.flags, remoteManaged: th.telemetry.remoteManaged, cacheFile: th.telemetry.cacheFile },
    { mode: 'block', status: 'blocked', flags: ['OTEL_LOG_USER_PROMPTS'], remoteManaged: 'loaded', cacheFile: 'present' },
    `telemetry: ${JSON.stringify(th.telemetry)}`,
  );
  assert.ok(!JSON.stringify(th).includes(TMP), 'health 에 경로 없음');
  const blockedRes = await fetch(`${T.base}api/sample`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${KEY}` }, body: '{"input":"안녕"}' });
  assert.equal(blockedRes.status, 503);
  const blockedBody = await blockedRes.json();
  assert.equal(blockedBody.code, 'telemetry_blocked');
  assert.deepEqual(blockedBody.flags, ['OTEL_LOG_USER_PROMPTS']);
  assert.ok(blockedBody.message.includes(TELEMETRY_TOAST));
  assert.equal(T.fakeCalls().length, 0, '차단되면 CLI 를 띄우지 않음');

  const ctxT = await browser.newContext(desktop);
  await withAccessKey(ctxT);
  const pt = watch(await ctxT.newPage(), 'T', ['503']); // 차단 응답(503)은 브라우저가 콘솔에 찍는다
  await pt.goto(`${T.base}jaso/`, { waitUntil: 'networkidle' });
  await ready(pt);
  assert.equal(await pt.locator('#stage .notice.bad', { hasText: TELEMETRY_NOTICE }).count(), 1, '작업 영역의 차단 안내');
  assert.equal(await pt.locator('#side .notice.bad.telemetry', { hasText: TELEMETRY_NOTICE }).count(), 1, '사이드바의 차단 안내');
  await pt.fill('#f-company', '네이버');
  await pt.fill('#f-role', '백엔드 개발');
  await pt.fill('#f-jd', JD);
  await pt.click('button[data-action="analyze-jd"]');
  await waitToast(pt, TELEMETRY_TOAST);
  await pt.waitForFunction(() => !window.__jaso.state.ui.busy);
  assert.equal(await pt.locator('.q-row').count(), 0);
  assert.equal(T.fakeCalls().length, 0, 'UI 에서도 CLI 미실행');
  await pt.screenshot({ path: path.join(SHOTS, 'sync-telemetry-blocked.png') });
  assert.match(T.log, /WARN 텔레메트리 가드\[block\]: \S+ → blocked \(OTEL_LOG_USER_PROMPTS@remote-settings\.json\) 원격관리=loaded 캐시=present/, '상태 변화 로그(키 이름·출처 파일 이름만)');
  step('텔레메트리 차단 서버: health blocked(OTEL_LOG_USER_PROMPTS), 차단 안내 2곳, 공고 분석 → 503 토스트, CLI 0회');

  // 운영자가 조직 설정을 끄면(캐시 파일이 바뀌면) 파일 감시 재검사로 풀린다
  fs.writeFileSync(path.join(T.configDir, 'remote-settings.json'), JSON.stringify({ env: { OTEL_LOG_USER_PROMPTS: '0', OTEL_METRICS_EXPORTER: 'otlp' } }));
  await waitFor(async () => (await T.health()).telemetry.status === 'clear', { timeout: 10000, what: '재검사 후 clear' });
  await pt.reload({ waitUntil: 'networkidle' });
  await ready(pt);
  assert.equal(await pt.locator('.notice.bad', { hasText: TELEMETRY_NOTICE }).count(), 0, '차단 안내가 사라짐');
  assert.match(await pt.locator('#side').textContent(), /조직 텔레메트리: 본문 수집 꺼짐 확인/);
  await pt.click('button[data-action="analyze-jd"]');
  await pt.waitForFunction(() => document.querySelectorAll('.q-row').length === 2 && !window.__jaso.state.ui.busy, null, { timeout: 15000 });
  assert.equal(T.fakeCalls().length, 1);
  assert.match(T.log, /INFO 텔레메트리 가드\[block\]: blocked → clear/);
  assert.ok(!T.log.includes(TMP), '서버 로그에 설정 폴더 경로가 없어야 함');
  await ctxT.close();
  step('캐시 파일 수정 → 재검사로 clear → 안내 사라지고 공고 분석 성공');

  assert.deepEqual(consoleErrors, [], `콘솔 오류: ${consoleErrors.join(' | ')}`);
  console.log(`\nE2E(동기화·PWA·폰·텔레메트리) 통과. CLI 실행: main ${A.fakeCalls().length}회, blocked ${T.fakeCalls().length}회. 스크린샷: ${SHOTS}`);
} catch (err) {
  for (const [tag, page] of Object.entries(pages)) {
    if (page.isClosed()) continue;
    await page.screenshot({ path: path.join(SHOTS, `sync-failure-${tag}.png`), fullPage: true }).catch(() => {});
    try { console.error(`[${tag}] sync:`, JSON.stringify(await syncState(page)), 'toasts:', JSON.stringify(await toastTexts(page))); } catch { /* 무시 */ }
  }
  console.error('E2E(동기화) 실패:', err);
  console.error('console errors:', consoleErrors);
  for (const s of servers) console.error(`[${s.name}] server log tail:\n${s.log.split('\n').slice(-25).join('\n')}`);
  process.exitCode = 1;
} finally {
  await browser.close();
  for (const s of servers) {
    const code = await stopServer(s);
    if (code !== 0) {
      console.error(`[${s.name}] 서버가 SIGTERM 뒤 0이 아닌 코드로 종료: ${code}`);
      process.exitCode = 1;
    }
  }
  fs.rmSync(TMP, { recursive: true, force: true });
}
