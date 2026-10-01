// 운영자 구독 서버(jaso/server) 단위·통합 테스트. 실제 claude 바이너리는 쓰지 않고
// test/helpers/fake-claude-cli.mjs 를 JASO_CLAUDE_BIN 으로 띄운다.
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { fileURLToPath } from 'node:url';
import {
  SYSTEM_PROMPT, TIERS, ERROR_TEXT, parseConfig, flattenInput, unflattenInput, buildArgs, childEnv, spawnSpec,
  createStreamParser, classifyFailure, checkAuth, keyDigest, createRateLimiter, resolveStatic, clientIp,
  errorMessage, sanitizeStderr, pickText, modelIdFrom, RequestError,
} from '../jaso/server/lib.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const SERVER = path.join(ROOT, 'jaso/server/server.mjs');
const FAKE = path.join(ROOT, 'test/helpers/fake-claude-cli.mjs');
const PROMPT = '[역할과 규칙]\n자기소개서 작가\n\n[요청]\n[작성할 문항]\nq1. 지원 동기';

// ───────────── 순수 헬퍼 ─────────────

test('flattenInput/unflattenInput: 문자열은 그대로, 메시지 배열은 마커 형식으로 왕복한다 (여러 줄·빈 줄 포함)', () => {
  const s = flattenInput('안녕\n세계');
  assert.deepEqual(s, { prompt: '안녕\n세계', kind: 'string', bytes: Buffer.byteLength('안녕\n세계') });
  assert.equal(unflattenInput('안녕\n세계'), '안녕\n세계');

  const msgs = [
    { role: 'user', content: '첫 질문입니다.\n\n두 번째 단락.\n  들여쓴 줄' },
    { role: 'assistant', content: '{"saved":[],"question":{"question":"경험?"}}' },
    { role: 'user', content: '저장됨: id=exp_1\n\n[지원자 답변]\n캡스톤' },
  ];
  const f = flattenInput(msgs);
  assert.equal(f.kind, 'messages');
  assert.equal(f.bytes, msgs.reduce((n, m) => n + Buffer.byteLength(m.content), 0));
  assert.ok(f.prompt.startsWith('[대화 기록] 아래는 지금까지의 대화입니다. 마지막 user 발화에 대한 assistant 응답만 출력하세요.\n\n[[USER]]\n'));
  assert.match(f.prompt, /\n\n\[\[ASSISTANT\]\]\n\{"saved"/);
  assert.equal((f.prompt.match(/^\[\[USER\]\]$/gm) || []).length, 2);
  assert.deepEqual(unflattenInput(f.prompt), msgs);
});

test('flattenInput: 잘못된 입력은 400 invalid_request 로 거절한다', () => {
  for (const bad of ['', '   ', [], [{ role: 'user', content: 'a' }, { role: 'assistant', content: 'b' }], [{ role: 'system', content: 'x' }], [{ role: 'user', content: 1 }], [null], 42, { role: 'user' }]) {
    assert.throws(() => flattenInput(bad), (e) => e instanceof RequestError && e.status === 400 && e.code === 'invalid_request', `입력: ${JSON.stringify(bad)}`);
  }
});

test('buildArgs: 인자 순서가 고정되고 폴백·스키마는 뒤에만 붙는다', () => {
  const base = ['-p', '--output-format', 'stream-json', '--verbose', '--include-partial-messages', '--tools', '', '--no-session-persistence', '--permission-prompts', 'none', '--disable-slash-commands', '--strict-mcp-config', '--setting-sources', '', '--model', 'opus', '--effort', 'high', '--system-prompt', SYSTEM_PROMPT];
  assert.deepEqual(buildArgs({ model: 'opus', effort: 'high' }), base);
  assert.deepEqual(buildArgs({ model: 'opus', effort: 'high', fallbackModel: 'sonnet' }), [...base, '--fallback-model', 'sonnet']);
  assert.deepEqual(buildArgs({ model: 'sonnet', effort: 'low', fallbackModel: 'sonnet' }).filter((a) => a === '--fallback-model'), [], '같은 모델이면 폴백 생략');
  assert.deepEqual(buildArgs({ model: 'opus', effort: 'high', fallbackModel: '', schema: { type: 'object' } }), [...base, '--json-schema', '{"type":"object"}']);
  assert.ok(!buildArgs({ model: 'x', effort: 'low' }).includes('--bare'));
});

test('childEnv: 화이트리스트만 통과, API 키는 기본 차단, 추가 통과 목록은 허용(접속 키·API 키 제외)', () => {
  const env = { HOME: '/h', PATH: '/bin', USER: 'u', LANG: 'ko', ANTHROPIC_API_KEY: 'sk-ant-x', ANTHROPIC_AUTH_TOKEN: 't', JASO_ACCESS_KEY: 'k', CLAUDE_CODE_OAUTH_TOKEN: 'oauth', FAKE_MODE: 'hang', HTTPS_PROXY: 'http://p', SECRET_THING: 'z' };
  const a = childEnv(env, parseConfig({}));
  assert.equal(a.HOME, '/h'); assert.equal(a.PATH, '/bin'); assert.equal(a.CLAUDE_CODE_OAUTH_TOKEN, 'oauth');
  assert.equal(a.ANTHROPIC_API_KEY, undefined); assert.equal(a.ANTHROPIC_AUTH_TOKEN, undefined);
  assert.equal(a.JASO_ACCESS_KEY, undefined); assert.equal(a.FAKE_MODE, undefined); assert.equal(a.SECRET_THING, undefined);
  assert.equal(a.TERM, 'dumb'); assert.equal(a.NO_COLOR, '1'); assert.equal(a.DISABLE_TELEMETRY, '1'); assert.equal(a.DISABLE_AUTOUPDATER, '1'); assert.equal(a.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC, '1');
  const b = childEnv(env, parseConfig({ JASO_CHILD_ENV_PASSTHROUGH: 'FAKE_MODE, HTTPS_PROXY,ANTHROPIC_API_KEY,JASO_ACCESS_KEY' }));
  assert.equal(b.FAKE_MODE, 'hang'); assert.equal(b.HTTPS_PROXY, 'http://p');
  assert.equal(b.ANTHROPIC_API_KEY, undefined); assert.equal(b.JASO_ACCESS_KEY, undefined);
  const c = childEnv(env, parseConfig({ JASO_ALLOW_API_KEY: '1' }));
  assert.equal(c.ANTHROPIC_API_KEY, 'sk-ant-x');
});

test('spawnSpec: .mjs/.js 경로는 현재 node 로 실행한다', () => {
  assert.deepEqual(spawnSpec('/x/fake.mjs', '/usr/bin/node'), { cmd: '/usr/bin/node', prefix: ['/x/fake.mjs'] });
  assert.deepEqual(spawnSpec('claude', '/usr/bin/node'), { cmd: 'claude', prefix: [] });
  assert.deepEqual(spawnSpec('', '/usr/bin/node'), { cmd: 'claude', prefix: [] });
});

test('parseConfig: 기본값과 환경 변수 덮어쓰기, 잘못된 값은 기본값', () => {
  const d = parseConfig({});
  assert.equal(d.host, '127.0.0.1'); assert.equal(d.port, 8080); assert.equal(d.accessKey, ''); assert.equal(d.allowAnon, false);
  assert.equal(d.claudeBin, 'claude'); assert.equal(d.concurrency, 1); assert.equal(d.maxQueue, 6); assert.equal(d.rateLimit, '40/600');
  assert.equal(d.maxInputBytes, 300000); assert.equal(d.maxBodyBytes, 1048576); assert.equal(d.firstOutputTimeoutMs, 120000); assert.equal(d.totalTimeoutMs, 600000);
  assert.deepEqual(d.tiers, { complex: { model: 'opus', effort: 'high' }, default: { model: 'sonnet', effort: 'medium' }, quick: { model: 'sonnet', effort: 'low' } });
  assert.deepEqual(d.tiers, JSON.parse(JSON.stringify(TIERS)));
  assert.equal(d.fallbackModel, 'sonnet'); assert.equal(d.loginProbe, true); assert.equal(d.allowApiKey, false); assert.equal(d.trustProxy, false);
  assert.equal(d.root, ROOT); assert.equal(d.workDir, path.join(os.tmpdir(), 'jaso-work'));
  const c = parseConfig({ JASO_PORT: '0', JASO_ACCESS_KEY: ' k ', JASO_CONCURRENCY: '0', JASO_MAX_QUEUE: '0', JASO_MODEL_COMPLEX: 'fable', JASO_EFFORT_COMPLEX: 'bogus', JASO_EFFORT_QUICK: 'xhigh', JASO_FALLBACK_MODEL: '', JASO_LOGIN_PROBE: '0', JASO_TRUST_PROXY: '1', JASO_FIRST_OUTPUT_TIMEOUT_MS: 'abc' });
  assert.equal(c.port, 0); assert.equal(c.accessKey, 'k'); assert.equal(c.concurrency, 1, '최소 1'); assert.equal(c.maxQueue, 0);
  assert.deepEqual(c.tiers.complex, { model: 'fable', effort: 'high' }); assert.equal(c.tiers.quick.effort, 'xhigh');
  assert.equal(c.fallbackModel, ''); assert.equal(c.loginProbe, false); assert.equal(c.trustProxy, true); assert.equal(c.firstOutputTimeoutMs, 120000);
});

test('createStreamParser: 조각난 줄·멀티바이트 분할·JSON 아닌 줄을 견디고 델타/사용량/결과를 낸다', () => {
  const p = createStreamParser();
  const lines = [
    '{"type":"active_goal","goal":null}',
    'not json at all',
    '{"type":"system","subtype":"init"}',
    '{"type":"stream_event","event":{"type":"message_start","message":{}}}',
    '{"type":"stream_event","event":{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"안녕 "}}}',
    '{"type":"stream_event","event":{"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"{\\"a\\":1}"}}}',
    '{"type":"stream_event","event":{"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"x"}}}',
    '{"type":"stream_event","event":{"type":"message_delta","delta":{"stop_reason":"end_turn"}}}',
    '{"type":"assistant","message":{"role":"assistant"}}',
    '{"type":"rate_limit_event","rate_limit_info":{"status":"allowed","resetsAt":123,"rateLimitType":"five_hour"}}',
    '{"type":"result","subtype":"success","is_error":false,"result":"안녕 세계"}',
  ];
  const whole = Buffer.from(`${lines.join('\n')}\n`, 'utf8');
  // 멀티바이트 글자(안녕) 한가운데를 포함해 7바이트 단위로 쪼개 넣는다
  const events = [];
  for (let i = 0; i < whole.length; i += 7) events.push(...p.feed(whole.subarray(i, i + 7)));
  events.push(...p.end());
  const types = events.map((e) => e.type);
  assert.equal(types.filter((t) => t === 'first_output').length, 1);
  assert.equal(types.indexOf('first_output'), 0, 'message_start 가 첫 모델 출력');
  assert.deepEqual(events.filter((e) => e.type === 'delta').map((e) => e.text), ['안녕 ', '{"a":1}']);
  assert.deepEqual(events.find((e) => e.type === 'stop'), { type: 'stop', stopReason: 'end_turn' });
  assert.deepEqual(events.find((e) => e.type === 'rateLimit').info, { status: 'allowed', resetsAt: 123, rateLimitType: 'five_hour' });
  assert.equal(events.find((e) => e.type === 'result').result.result, '안녕 세계');
  assert.equal(events.filter((e) => e.type === 'assistant').length, 1);
  assert.equal(p.sawOutput, true);

  const q = createStreamParser();
  assert.deepEqual(q.feed('{"type":"result","result":"끝"}'), [], '줄바꿈 없는 마지막 줄은 end()에서');
  assert.deepEqual(q.end().map((e) => e.type), ['first_output', 'result']);
  assert.deepEqual(createStreamParser().feed('{"type":"system"}\n\n   \n{bad json\n'), []);
});

test('classifyFailure: 상태 표', () => {
  const t = (args) => { const f = classifyFailure(args); return f && [f.status, f.code]; };
  assert.deepEqual(t({ timedOut: 'first' }), [504, 'timeout']);
  assert.equal(classifyFailure({ timedOut: true }).message, '응답이 너무 오래 걸립니다. 운영자의 Claude 로그인 상태를 확인해야 할 수 있습니다.');
  assert.equal(t({ result: { type: 'result', is_error: false, result: '본문', stop_reason: 'end_turn' }, exitCode: 0 }), null);
  assert.deepEqual(t({ result: { is_error: false, result: '', stop_reason: 'refusal' }, exitCode: 0 }), [422, 'refused']);
  const ul = classifyFailure({ result: { is_error: true, result: "You've hit your usage limit" }, exitCode: 1, lastRateLimit: { status: 'rejected', resetsAt: 1800000000 } });
  assert.deepEqual([ul.status, ul.code, ul.resetsAt], [429, 'usage_limit', 1800000000]);
  assert.match(ul.message, /사용량 한도/); assert.ok(!/\{시각\}/.test(ul.message)); assert.match(ul.message, /이후 다시 시도/);
  assert.deepEqual(t({ result: { is_error: true, result: 'rate limit reached, try later' }, exitCode: 1 }), [429, 'usage_limit']);
  assert.equal(classifyFailure({ result: { is_error: true, result: 'usage limit' }, exitCode: 1 }).message, ERROR_TEXT.usage_limit_unknown);
  assert.deepEqual(t({ result: { is_error: true, result: 'Not logged in · Please run /login' }, exitCode: 1 }), [503, 'nologin']);
  assert.deepEqual(t({ result: { is_error: true, result: 'x', api_error_status: 401 }, exitCode: 1 }), [503, 'nologin']);
  assert.deepEqual(t({ stderr: 'OAuth token expired', exitCode: 1 }), [503, 'nologin']);
  assert.deepEqual(t({ stderr: 'Invalid API key · Please run /login', exitCode: 1 }), [503, 'nologin']);
  assert.deepEqual(t({ stderr: 'boom', exitCode: 1 }), [502, 'upstream_error']);
  assert.equal(classifyFailure({ stderr: 'boom', exitCode: 1 }).detail, 'boom');
  const um = classifyFailure({ result: { is_error: true, result: 'Unknown model' }, stderr: '[claude-code:unrecognized_model] {"model":"x"}', exitCode: 1 });
  assert.deepEqual([um.status, um.code], [502, 'upstream_error']); assert.match(um.detail, /unrecognized_model/);
  assert.deepEqual(t({ exitCode: 0 }), [502, 'upstream_error'], 'result 줄이 없으면 업스트림 오류');
  assert.deepEqual(t({ stderr: '', exitCode: 1, lastRateLimit: { status: 'rejected' } }), [429, 'usage_limit']);
  assert.deepEqual(t({ stderr: 'boom', exitCode: 1, lastRateLimit: { status: 'allowed_warning' } }), [502, 'upstream_error'], 'allowed_warning 은 정상 상태');
  assert.deepEqual(t({ result: { is_error: true, result: 'x', api_error_status: 500 }, exitCode: 1, lastRateLimit: { status: 'allowed_warning' } }), [502, 'upstream_error']);
  const long = classifyFailure({ stderr: `${'x'.repeat(500)} Authorization: Bearer abc.def token=sk-ant-123`, exitCode: 1 });
  assert.ok(long.detail.length <= 300); assert.ok(!/abc\.def|sk-ant-123/.test(long.detail));
  assert.equal(sanitizeStderr('\x1b[31mred\x1b[0m  api_key: abc'), 'red api_key: [redacted]');
});

test('pickText/modelIdFrom/errorMessage', () => {
  assert.equal(pickText({ result: '본문' }, '누적'), '본문');
  assert.equal(pickText({ result: '' }, '누적'), '누적');
  assert.equal(pickText(null, '누적'), '누적');
  assert.equal(modelIdFrom({ modelUsage: { 'claude-opus-4-1': {} } }, 'opus'), 'claude-opus-4-1');
  assert.equal(modelIdFrom({}, 'opus'), 'opus');
  assert.equal(errorMessage('rate_limited', { retryAfterSec: 12.2 }), '요청이 너무 많습니다. 13초 후 다시 시도해 주세요.');
  assert.equal(errorMessage('busy'), '지금 다른 요청을 처리하고 있습니다. 잠시 후 다시 시도해 주세요.');
  assert.equal(errorMessage('nologin'), '운영자의 Claude 로그인이 만료되었거나 설정되지 않았습니다. 운영자에게 알려 주세요.');
  assert.equal(errorMessage('unauthorized'), '접속 키가 올바르지 않습니다.');
});

test('checkAuth: Bearer 키를 sha256 다이제스트로 상수 시간 비교한다 (길이 달라도 예외 없음)', () => {
  const d = keyDigest('secret-key');
  assert.equal(checkAuth('Bearer secret-key', d), true);
  assert.equal(checkAuth('bearer secret-key', d), true);
  assert.equal(checkAuth('  Bearer   secret-key  ', d), true);
  assert.equal(checkAuth('Bearer secret-ke', d), false);
  assert.equal(checkAuth('Bearer secret-key-with-a-much-longer-suffix', d), false);
  assert.equal(checkAuth('Bearer ', d), false);
  assert.equal(checkAuth('Basic c2VjcmV0', d), false);
  assert.equal(checkAuth(undefined, d), false);
  assert.equal(checkAuth('secret-key', d), false);
  assert.equal(checkAuth('Bearer secret-key', null), false);
});

test('createRateLimiter: 슬라이딩 윈도 count/seconds, retryAfterSec, check 는 기록하지 않음', () => {
  let t = 1_000_000;
  const rl = createRateLimiter('2/10', { now: () => t });
  assert.deepEqual(rl.hit('a'), { ok: true, remaining: 2 });
  assert.deepEqual(rl.check('a'), { ok: true, remaining: 1 });
  assert.deepEqual(rl.hit('a'), { ok: true, remaining: 1 });
  assert.deepEqual(rl.hit('a'), { ok: false, retryAfterSec: 10 });
  assert.deepEqual(rl.hit('b'), { ok: true, remaining: 2 }, '키별 독립');
  t += 4000;
  assert.deepEqual(rl.check('a'), { ok: false, retryAfterSec: 6 });
  t += 6001;
  assert.equal(rl.hit('a').ok, true, '첫 기록이 창 밖으로 나가면 다시 허용');
  t += 100_000; rl.sweep();
  assert.equal(rl.size(), 0);
  assert.equal(createRateLimiter('0/600').hit('x').ok, true, '0 이면 무제한');
  assert.deepEqual([createRateLimiter('garbage').count, createRateLimiter('garbage').seconds], [40, 600]);
});

test('resolveStatic: /jaso/ 아래와 루트 *.html 만, 서버 폴더·숨김 파일·상위 이동은 거절', () => {
  const root = '/srv/app';
  const r = (p) => resolveStatic(root, p);
  assert.equal(r('/jaso/'), '/srv/app/jaso/index.html');
  assert.equal(r('/jaso/index.html'), '/srv/app/jaso/index.html');
  assert.equal(r('/jaso/src/app.js'), '/srv/app/jaso/src/app.js');
  assert.equal(r('/jaso/vendor/anthropic-sdk.mjs'), '/srv/app/jaso/vendor/anthropic-sdk.mjs');
  assert.equal(r('/jaso/dist/artifact.html'), '/srv/app/jaso/dist/artifact.html');
  assert.equal(r('/jaso/%EC%9E%90%EC%86%8C.txt'), '/srv/app/jaso/자소.txt', '%xx 는 한 번 디코드');
  assert.equal(r('/privacy.html'), '/srv/app/privacy.html');
  assert.equal(r('/data-deletion.html'), '/srv/app/data-deletion.html');
  assert.equal(r('/index.html'), '/srv/app/index.html');
  for (const bad of ['/jaso/server/lib.mjs', '/jaso/Server/lib.mjs', '/jaso/SERVER/server.mjs', '/jaso/server/', '/jaso/server', '/jaso', '/package.json', '/README.md', '/deploy/wsl/install.sh', '/jaso/../package.json', '/jaso/%2e%2e/package.json', '/jaso/..%2Fpackage.json', '/../etc/passwd', '/.git/config', '/jaso/.hidden', '/jaso/src/', '/jaso//index.html', '/jaso/src/./app.js', '/jaso/a%00.js', '/jaso/%zz', 'jaso/index.html', '/jaso/sub\\..\\x.js', '/', '']) {
    assert.equal(r(bad), null, `거절되어야 함: ${bad}`);
  }
  assert.equal(r('/jaso/%252e%252e/x.js'), '/srv/app/jaso/%2e%2e/x.js', '이중 인코딩은 글자 그대로의 폴더명');
});

test('clientIp: 프록시 신뢰 여부에 따라 헤더 또는 소켓 주소', () => {
  const req = { headers: { 'x-forwarded-for': '203.0.113.9, 10.0.0.1', 'cf-connecting-ip': '198.51.100.7' }, socket: { remoteAddress: '::ffff:127.0.0.1' } };
  assert.equal(clientIp(req, false), '127.0.0.1');
  assert.equal(clientIp(req, true), '198.51.100.7');
  assert.equal(clientIp({ headers: { 'x-forwarded-for': ' 203.0.113.9 ,10.0.0.1' }, socket: { remoteAddress: '127.0.0.1' } }, true), '10.0.0.1', '마지막 항목(신뢰 홉이 붙인 값)');
  assert.equal(clientIp({ headers: { 'x-forwarded-for': 'evil, not-an-ip' }, socket: { remoteAddress: '127.0.0.1' } }, true), '127.0.0.1', 'IP 형식이 아니면 소켓 주소');
  assert.equal(clientIp({ headers: { 'cf-connecting-ip': 'garbage', 'x-forwarded-for': '198.51.100.8' }, socket: { remoteAddress: '127.0.0.1' } }, true), '198.51.100.8');
  assert.equal(clientIp({ headers: { 'x-forwarded-for': '2001:db8::1' }, socket: { remoteAddress: '127.0.0.1' } }, true), '2001:db8::1');
  assert.equal(clientIp({ headers: {}, socket: { remoteAddress: '::1' } }, true), '::1');
  assert.equal(clientIp({ headers: {}, socket: {} }, false), 'unknown');
});

// ───────────── 통합: 서버를 자식 프로세스로 띄운다 ─────────────

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'jaso-server-test-'));
const servers = new Set();

async function startServer(extra = {}) {
  const env = {
    PATH: process.env.PATH, HOME: process.env.HOME, LANG: process.env.LANG ?? 'C.UTF-8',
    JASO_PORT: '0', JASO_ACCESS_KEY: 'k', JASO_LOGIN_PROBE: '0', JASO_CLAUDE_BIN: FAKE,
    JASO_CHILD_ENV_PASSTHROUGH: 'FAKE_MODE,FAKE_DELAY_MS,FAKE_LOG,FAKE_RATE_STATUS,FAKE_LOGGED_IN',
    JASO_WORK_DIR: path.join(tmpRoot, 'work'), JASO_LOG_LEVEL: 'silent',
    ...extra,
  };
  for (const k of Object.keys(env)) if (env[k] === undefined) delete env[k];
  const proc = spawn(process.execPath, [SERVER], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let stderr = '';
  proc.stderr.on('data', (d) => { stderr += d; });
  const url = await new Promise((resolve, reject) => {
    let out = '';
    const timer = setTimeout(() => reject(new Error(`서버가 시작되지 않음\n${stderr}`)), 10000);
    proc.stdout.on('data', (d) => {
      out += d;
      const m = /jaso server listening on (http:\/\/[^\s/]+\/)\n/.exec(out);
      if (m) { clearTimeout(timer); resolve(m[1]); }
    });
    proc.on('exit', (code) => { clearTimeout(timer); reject(new Error(`서버 종료 code=${code}\n${stderr}`)); });
  });
  const handle = {
    url, proc,
    stderr: () => stderr,
    stop: () => new Promise((resolve) => {
      if (proc.exitCode !== null) return resolve(proc.exitCode);
      const t = setTimeout(() => proc.kill('SIGKILL'), 8000);
      proc.once('exit', (code) => { clearTimeout(t); servers.delete(handle); resolve(code); });
      proc.kill('SIGTERM');
    }),
  };
  servers.add(handle);
  return handle;
}

const post = (url, body, { key = 'k', headers = {}, signal } = {}) => fetch(`${url}api/sample`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', ...(key ? { authorization: `Bearer ${key}` } : {}), ...headers },
  body: typeof body === 'string' ? body : JSON.stringify(body),
  signal,
});
const health = async (url) => (await fetch(`${url}api/health`)).json();

/** SSE 본문 → [{event, data}] (주석 줄 무시) */
function parseSSE(text) {
  return text.split('\n\n').map((block) => block.trim()).filter(Boolean).filter((b) => !b.startsWith(':')).map((block) => {
    let event = 'message';
    const data = [];
    for (const line of block.split('\n')) {
      if (line.startsWith('event:')) event = line.slice(6).trim();
      else if (line.startsWith('data:')) data.push(line.slice(5).trim());
    }
    return { event, data: data.length ? JSON.parse(data.join('\n')) : null };
  });
}

function rawRequest(url, requestLine) {
  const u = new URL(url);
  return new Promise((resolve, reject) => {
    const sock = net.connect(Number(u.port), u.hostname, () => {
      sock.write(`${requestLine}\r\nHost: ${u.host}\r\nConnection: close\r\n\r\n`);
    });
    let buf = '';
    sock.on('data', (d) => { buf += d; });
    sock.on('end', () => resolve(buf));
    sock.on('error', reject);
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

describe('서버 통합', () => {
  let S;
  const fakeLog = path.join(tmpRoot, 'fake.log');
  before(async () => { S = await startServer({ FAKE_LOG: fakeLog }); });
  after(async () => { for (const h of [...servers]) await h.stop(); fs.rmSync(tmpRoot, { recursive: true, force: true }); });

  test('health: 형태와 보안 헤더, HEAD 200', async () => {
    const res = await fetch(`${S.url}api/health`);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('content-type'), 'application/json; charset=utf-8');
    assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(res.headers.get('referrer-policy'), 'no-referrer');
    assert.equal(res.headers.get('x-frame-options'), 'DENY');
    assert.equal(res.headers.get('cache-control'), 'no-store');
    assert.equal(res.headers.get('access-control-allow-origin'), null, 'CORS 없음');
    const h = await res.json();
    assert.equal(h.service, 'jaso'); assert.equal(h.runtime, 'server'); assert.equal(h.version, '1'); assert.equal(h.auth, 'key');
    assert.deepEqual(Object.keys(h.login).sort(), ['checkedAt', 'detail', 'method', 'ok']);
    assert.equal(h.login.ok, true); assert.equal(h.login.method, 'claude.ai'); assert.ok(h.login.checkedAt > 0);
    assert.deepEqual(h.queue, { active: 0, waiting: 0, concurrency: 1, maxQueue: 6 });
    assert.equal(h.usageWindow, null);
    assert.deepEqual(h.limits, { maxPromptBytes: 300000 });
    assert.deepEqual(h.tiers, { complex: { model: 'opus', effort: 'high' }, default: { model: 'sonnet', effort: 'medium' }, quick: { model: 'sonnet', effort: 'low' } });
    const head = await fetch(`${S.url}api/health`, { method: 'HEAD' });
    assert.equal(head.status, 200);
    assert.equal((await head.text()), '');
    assert.equal((await fetch(`${S.url}api/health`, { method: 'POST' })).status, 405);
    assert.equal((await fetch(`${S.url}api/nothing`)).status, 404);
  });

  test('인증: 키 없음·틀린 키 → 401 + WWW-Authenticate, 사용 통계는 안 바뀜', async () => {
    const r1 = await post(S.url, { input: PROMPT }, { key: '' });
    assert.equal(r1.status, 401);
    assert.equal(r1.headers.get('www-authenticate'), 'Bearer');
    assert.deepEqual(await r1.json(), { code: 'unauthorized', message: '접속 키가 올바르지 않습니다.' });
    const r2 = await post(S.url, { input: PROMPT }, { key: 'kk' });
    assert.equal(r2.status, 401);
    assert.equal((await fetch(`${S.url}api/sample`)).status, 405);
  });

  test('정적: / 와 /jaso 는 /jaso/ 로, index.html 200, 서버 폴더·루트 밖·상위 이동은 404, 304 지원', async () => {
    const r = await fetch(S.url, { redirect: 'manual' });
    assert.equal(r.status, 302); assert.equal(r.headers.get('location'), '/jaso/');
    const r2 = await fetch(`${S.url}jaso`, { redirect: 'manual' });
    assert.equal(r2.status, 302); assert.equal(r2.headers.get('location'), '/jaso/');
    const idx = await fetch(`${S.url}jaso/index.html`);
    assert.equal(idx.status, 200);
    assert.equal(idx.headers.get('content-type'), 'text/html; charset=utf-8');
    assert.equal(idx.headers.get('cache-control'), 'no-cache');
    assert.equal(idx.headers.get('x-frame-options'), 'DENY');
    assert.ok(idx.headers.get('last-modified'));
    assert.match(await idx.text(), /자소서 에이전트/);
    const slash = await fetch(`${S.url}jaso/`);
    assert.equal(slash.status, 200); assert.match(await slash.text(), /<!doctype html>/i);
    const js = await fetch(`${S.url}jaso/src/app.js`);
    assert.equal(js.status, 200); assert.equal(js.headers.get('content-type'), 'text/javascript; charset=utf-8');
    const css = await fetch(`${S.url}jaso/style.css`, { method: 'HEAD' });
    assert.equal(css.status, 200); assert.equal(css.headers.get('content-type'), 'text/css; charset=utf-8'); assert.ok(Number(css.headers.get('content-length')) > 0);
    assert.equal((await fetch(`${S.url}jaso/server/lib.mjs`)).status, 404);
    assert.equal((await fetch(`${S.url}jaso/server/server.mjs`)).status, 404);
    assert.equal((await fetch(`${S.url}package.json`)).status, 404);
    assert.equal((await fetch(`${S.url}jaso/%2e%2e/package.json`)).status, 404);
    assert.equal((await fetch(`${S.url}.git/config`)).status, 404);
    assert.equal((await fetch(`${S.url}jaso/nope.js`)).status, 404);
    assert.equal((await fetch(`${S.url}privacy.html`)).status, 200);
    const raw = await rawRequest(S.url, 'GET /../package.json HTTP/1.1');
    assert.match(raw, /^HTTP\/1\.1 404/);
    const raw2 = await rawRequest(S.url, 'GET /jaso/../package.json HTTP/1.1');
    assert.match(raw2, /^HTTP\/1\.1 404/);
    const ims = await fetch(`${S.url}jaso/index.html`, { headers: { 'if-modified-since': idx.headers.get('last-modified') } });
    assert.equal(ims.status, 304);
    assert.equal((await fetch(`${S.url}jaso/index.html`, { method: 'POST' })).status, 405);
    assert.equal((await fetch(`${S.url}jaso/index.html`, { method: 'DELETE' })).status, 405);
  });

  test('sample 비스트리밍: 텍스트 응답 형태, 등급·모델 반영', async () => {
    const res = await post(S.url, { input: PROMPT, modelTier: 'complex' });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('content-type'), 'application/json; charset=utf-8');
    const j = await res.json();
    assert.match(j.text, /^\[성능 개선으로 증명한 집요함\]/);
    assert.equal(j.truncated, false);
    assert.equal(j.modelTierApplied, 'complex');
    assert.match(j.model, /opus/);
    assert.equal(j.data, null);
    assert.deepEqual(j.usage, { input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 });
    assert.equal(j.costUsd, 0.001);
    const d = await (await post(S.url, { input: PROMPT })).json();
    assert.equal(d.modelTierApplied, 'default'); assert.match(d.model, /sonnet/);
    const h = await health(S.url);
    assert.equal(h.usageWindow.status, 'allowed'); assert.equal(h.usageWindow.type, 'five_hour'); assert.ok(h.usageWindow.resetsAt > Date.now() / 1000);
    const log = fs.readFileSync(fakeLog, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    const last = log.at(-1);
    assert.deepEqual([last.model, last.effort, last.hasSchema, last.inputKind], ['sonnet', 'medium', false, 'string']);
    assert.deepEqual([log.at(-2).model, log.at(-2).effort], ['opus', 'high']);
  });

  test('sample 스트리밍: Accept 또는 stream:true 로 SSE, delta…done 순서, text 누적', async () => {
    const res = await post(S.url, { input: PROMPT, stream: true });
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type'), /^text\/event-stream/);
    assert.equal(res.headers.get('cache-control'), 'no-store');
    const events = parseSSE(await res.text());
    const names = events.map((e) => e.event);
    assert.ok(names.length >= 3);
    assert.equal(names.at(-1), 'done');
    assert.deepEqual([...new Set(names.slice(0, -1))], ['delta']);
    let acc = '';
    for (const e of events.slice(0, -1)) { acc += e.data.delta; assert.equal(e.data.text, acc, '누적 텍스트'); }
    const done = events.at(-1).data;
    assert.equal(done.text, acc);
    assert.equal(done.modelTierApplied, 'default'); assert.equal(done.truncated, false); assert.equal(done.data, null);
    const res2 = await post(S.url, { input: PROMPT, modelTier: 'quick' }, { headers: { accept: 'text/event-stream' } });
    assert.match(res2.headers.get('content-type'), /^text\/event-stream/);
    const ev2 = parseSSE(await res2.text());
    assert.equal(ev2.at(-1).event, 'done'); assert.equal(ev2.at(-1).data.modelTierApplied, 'quick');
    const log = fs.readFileSync(fakeLog, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    assert.deepEqual([log.at(-1).model, log.at(-1).effort], ['sonnet', 'low']);
  });

  test('schema 가 있으면 --json-schema 로 넘기고 data 에 구조화 출력, 델타는 partial_json', async () => {
    const schema = { type: 'object', properties: { company: { type: 'string' } } };
    const res = await post(S.url, { input: `[역할과 규칙]\n채용 분석가\n\n[요청]\n공고 분석`, schema });
    assert.equal(res.status, 200);
    const j = await res.json();
    assert.equal(j.data.company, '네이버'); assert.equal(j.data.role, '백엔드 개발');
    assert.equal(JSON.parse(j.text).company, '네이버');
    const log = fs.readFileSync(fakeLog, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    assert.equal(log.at(-1).hasSchema, true);
    const st = await post(S.url, { input: `[역할과 규칙]\n면접관\n\n[요청]\n예상 질문`, schema, stream: true });
    const ev = parseSSE(await st.text());
    assert.equal(ev.at(-1).event, 'done');
    assert.ok(Array.isArray(ev.at(-1).data.data.questions));
    assert.equal(ev.filter((e) => e.event === 'delta').map((e) => e.data.delta).join(''), ev.at(-1).data.text);
    // 스키마가 있는데 결과가 JSON 이 아니면 invalid_json
    const bad = await post(S.url, { input: PROMPT, schema });
    assert.equal(bad.status, 502);
    assert.equal((await bad.json()).code, 'invalid_json');
  });

  test('메시지 배열 입력은 평탄화되어 CLI 로 가고 가짜 CLI 는 배열로 복원한다', async () => {
    const input = [
      { role: 'user', content: '[역할과 규칙]\n인터뷰어\n\n응답 형식 JSON' },
      { role: 'assistant', content: '{"saved":[],"question":{"question":"경험 후보?"},"finish":null}' },
      { role: 'user', content: '[지원자 답변]\n캡스톤 프로젝트' },
    ];
    const res = await post(S.url, { input, schema: { type: 'object' } });
    assert.equal(res.status, 200);
    const j = await res.json();
    assert.ok(j.data && typeof j.data === 'object' && 'question' in j.data);
    const log = fs.readFileSync(fakeLog, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    assert.equal(log.at(-1).inputKind, 'messages'); assert.equal(log.at(-1).turns, 3);
  });

  test('400: JSON 깨짐·input 없음·assistant 로 끝남·등급 오류·schema 배열', async () => {
    const cases = [
      ['{nope', 'body is not JSON'],
      [{}, 'input'],
      [{ input: '' }, 'empty'],
      [{ input: [{ role: 'user', content: 'a' }, { role: 'assistant', content: 'b' }] }, 'user turn'],
      [{ input: 'x', modelTier: 'ultra' }, 'modelTier'],
      [{ input: 'x', schema: [1] }, 'schema'],
      [[1, 2], 'object'],
    ];
    for (const [body, hint] of cases) {
      const res = await post(S.url, body);
      assert.equal(res.status, 400, `400 이어야 함: ${hint}`);
      const j = await res.json();
      assert.equal(j.code, 'invalid_request');
      assert.ok(j.message.length > 0);
    }
  });

  test('413: 입력이 JASO_MAX_INPUT_BYTES 를 넘으면 prompt_too_large', async () => {
    const res = await post(S.url, { input: 'a'.repeat(300001) });
    assert.equal(res.status, 413);
    assert.deepEqual(await res.json(), { code: 'prompt_too_large', message: '보내는 내용이 너무 깁니다. 경험 카드나 공고 내용을 줄여 주세요.' });
    const msgs = await post(S.url, { input: [{ role: 'user', content: '가'.repeat(100001) }] });
    assert.equal(msgs.status, 413, '메시지 content 바이트 합산(한글 3바이트)');
  });

  test('본문 크기 상한(JASO_MAX_BODY_BYTES) 초과 → 413', async () => {
    const srv = await startServer({ JASO_MAX_BODY_BYTES: '2000' });
    const res = await post(srv.url, { input: 'b'.repeat(2500) });
    assert.equal(res.status, 413);
    assert.equal((await res.json()).code, 'prompt_too_large');
    const ok = await post(srv.url, { input: PROMPT });
    assert.equal(ok.status, 200);
    await srv.stop();
  });

  test('동시성 1: 두 요청을 동시에 보내면 둘 다 성공하고 하나는 queued 이벤트를 받는다', async () => {
    const srv = await startServer({ FAKE_DELAY_MS: '150' });
    const [a, b] = await Promise.all([post(srv.url, { input: PROMPT, stream: true }), post(srv.url, { input: PROMPT, stream: true })]);
    assert.equal(a.status, 200); assert.equal(b.status, 200);
    const ea = parseSSE(await a.text());
    const eb = parseSSE(await b.text());
    assert.equal(ea.at(-1).event, 'done'); assert.equal(eb.at(-1).event, 'done');
    const queued = [...ea, ...eb].filter((e) => e.event === 'queued');
    assert.ok(queued.length >= 1, 'queued 이벤트가 있어야 함');
    assert.equal(queued[0].data.position, 1);
    const h = await health(srv.url);
    assert.deepEqual([h.queue.active, h.queue.waiting], [0, 0]);
    await srv.stop();
  });

  test('JASO_MAX_QUEUE=0: 동시 두 요청 중 하나는 503 busy', async () => {
    const srv = await startServer({ FAKE_DELAY_MS: '150', JASO_MAX_QUEUE: '0' });
    const [a, b] = await Promise.all([post(srv.url, { input: PROMPT }), post(srv.url, { input: PROMPT })]);
    const statuses = [a.status, b.status].sort();
    assert.deepEqual(statuses, [200, 503]);
    const busy = a.status === 503 ? await a.json() : await b.json();
    assert.deepEqual(busy, { code: 'busy', message: '지금 다른 요청을 처리하고 있습니다. 잠시 후 다시 시도해 주세요.' });
    assert.equal((await health(srv.url)).queue.maxQueue, 0);
    await srv.stop();
  });

  const modes = [
    ['usage_limit', 429, 'usage_limit'],
    ['nologin', 503, 'nologin'],
    ['crash', 502, 'upstream_error'],
    ['refusal', 422, 'refused'],
    ['truncate', 200, null],
    ['hang', 504, 'timeout'],
  ];
  for (const [mode, status, code] of modes) {
    test(`FAKE_MODE=${mode} → ${status}${code ? ` ${code}` : ' truncated:true'}`, async () => {
      const srv = await startServer({ FAKE_MODE: mode, ...(mode === 'hang' ? { JASO_FIRST_OUTPUT_TIMEOUT_MS: '300' } : {}) });
      const t0 = Date.now();
      const res = await post(srv.url, { input: PROMPT });
      assert.equal(res.status, status);
      const j = await res.json();
      if (code) {
        assert.equal(j.code, code);
        assert.ok(typeof j.message === 'string' && j.message.length > 0);
      }
      if (mode === 'usage_limit') {
        assert.ok(Number.isFinite(j.resetsAt) && j.resetsAt > Date.now() / 1000);
        assert.match(j.message, /사용량 한도/); assert.match(j.message, /이후 다시 시도/);
        assert.equal((await health(srv.url)).usageWindow.status, 'rejected');
      }
      if (mode === 'nologin') {
        assert.equal(j.message, '운영자의 Claude 로그인이 만료되었거나 설정되지 않았습니다. 운영자에게 알려 주세요.');
        const h = await health(srv.url);
        assert.equal(h.login.ok, false, '이후 health 는 로그인 실패를 알린다');
        assert.ok(!/Please run|login/i.test(h.login.detail), 'health 에는 CLI stderr 가 노출되지 않는다');
        assert.equal(h.login.detail, '요청 처리 중 로그인 오류');
        const again = await post(srv.url, { input: PROMPT });
        assert.equal(again.status, 503, '5분 안에는 재확인 없이 바로 503');
      }
      if (mode === 'crash') { assert.equal(j.detail, 'boom'); assert.equal(j.message, '일시적인 오류입니다. 잠시 후 다시 시도해 주세요.'); }
      if (mode === 'truncate') { assert.equal(j.truncated, true); assert.ok(j.text.length > 0); }
      if (mode === 'hang') {
        assert.ok(Date.now() - t0 < 5000, '짧은 타임아웃으로 빨리 끝나야 함');
        assert.match(j.message, /로그인 상태를 확인/);
        for (let i = 0; i < 30 && (await health(srv.url)).queue.active !== 0; i++) await sleep(100);
        assert.equal((await health(srv.url)).queue.active, 0, '자식을 죽이고 슬롯을 비운다');
      }
      await srv.stop();
    });
  }

  test('Content-Type 이 application/json 이 아니면 400 (교차 사이트 단순 요청 차단)', async () => {
    const srv = await startServer({ FAKE_LOG: path.join(tmpRoot, 'ctype.log') });
    const res = await fetch(`${srv.url}api/sample`, { method: 'POST', headers: { 'content-type': 'text/plain', authorization: 'Bearer k' }, body: JSON.stringify({ input: PROMPT }) });
    assert.equal(res.status, 400); assert.equal((await res.json()).code, 'invalid_request');
    assert.ok(!fs.existsSync(path.join(tmpRoot, 'ctype.log')), 'CLI 를 실행하지 않는다');
    await srv.stop();
  });

  test('FAKE_MODE=refusal 스트리밍이면 error 이벤트로 전달된다', async () => {
    const srv = await startServer({ FAKE_MODE: 'refusal' });
    const res = await post(srv.url, { input: PROMPT, stream: true });
    assert.equal(res.status, 200);
    const ev = parseSSE(await res.text());
    assert.equal(ev.at(-1).event, 'error');
    assert.equal(ev.at(-1).data.code, 'refused');
    await srv.stop();
  });

  test('IP 별 속도 제한 JASO_RATE_LIMIT=2/600: 세 번째는 429 rate_limited + Retry-After', async () => {
    const srv = await startServer({ JASO_RATE_LIMIT: '2/600' });
    assert.equal((await post(srv.url, { input: PROMPT })).status, 200);
    assert.equal((await post(srv.url, { input: PROMPT })).status, 200);
    const third = await post(srv.url, { input: PROMPT });
    assert.equal(third.status, 429);
    const j = await third.json();
    assert.equal(j.code, 'rate_limited');
    assert.ok(j.retryAfterSec >= 1 && j.retryAfterSec <= 600);
    assert.equal(j.message, `요청이 너무 많습니다. ${j.retryAfterSec}초 후 다시 시도해 주세요.`);
    assert.equal(third.headers.get('retry-after'), String(j.retryAfterSec));
    assert.equal((await fetch(`${srv.url}api/health`)).status, 200, 'health 는 제한 밖');
    await srv.stop();
  });

  test('인증 실패 반복 JASO_AUTH_FAIL_LIMIT=2/600: 세 번째 시도부터 429, 올바른 키도 잠시 막힘', async () => {
    const srv = await startServer({ JASO_AUTH_FAIL_LIMIT: '2/600' });
    assert.equal((await post(srv.url, { input: PROMPT }, { key: 'bad' })).status, 401);
    assert.equal((await post(srv.url, { input: PROMPT }, { key: 'bad' })).status, 401);
    const r = await post(srv.url, { input: PROMPT }, { key: 'bad' });
    assert.equal(r.status, 429); assert.equal((await r.json()).code, 'rate_limited');
    assert.equal((await post(srv.url, { input: PROMPT })).status, 429);
    await srv.stop();
  });

  test('스트리밍 중 클라이언트가 끊으면 자식을 죽이고 3초 안에 슬롯을 비운다', async () => {
    const srv = await startServer({ FAKE_DELAY_MS: '2000' });
    const ac = new AbortController();
    const res = await post(srv.url, { input: PROMPT, stream: true }, { signal: ac.signal });
    assert.equal(res.status, 200);
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    while (!/event: delta/.test(buf)) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
    }
    assert.match(buf, /event: delta/);
    assert.equal((await health(srv.url)).queue.active, 1, '아직 자식이 실행 중');
    const t0 = Date.now();
    ac.abort();
    let active = 1;
    while (Date.now() - t0 < 3000) {
      active = (await health(srv.url)).queue.active;
      if (active === 0) break;
      await sleep(50);
    }
    assert.equal(active, 0, '3초 안에 queue.active 가 0 으로 돌아와야 함');
    // 서버는 계속 정상 동작
    const ok = await post(srv.url, { input: PROMPT, modelTier: 'quick' }, { headers: {} });
    assert.equal(ok.status, 200);
    await srv.stop();
  }, { timeout: 20000 });

  test('JASO_ALLOW_ANON=1: 키 없이 사용 가능하고 health.auth 는 open', async () => {
    const srv = await startServer({ JASO_ACCESS_KEY: '', JASO_ALLOW_ANON: '1' });
    assert.equal((await health(srv.url)).auth, 'open');
    const res = await post(srv.url, { input: PROMPT }, { key: '' });
    assert.equal(res.status, 200);
    await srv.stop();
  });

  test('FAKE_LOGGED_IN=0: 시작 시 auth status 가 로그아웃이면 health.login.ok=false, sample → 503 nologin', async () => {
    const srv = await startServer({ FAKE_LOGGED_IN: '0' });
    const h = await health(srv.url);
    assert.equal(h.login.ok, false); assert.ok(h.login.detail.length > 0);
    const res = await post(srv.url, { input: PROMPT });
    assert.equal(res.status, 503); assert.equal((await res.json()).code, 'nologin');
    assert.equal((await fetch(`${srv.url}jaso/index.html`)).status, 200, '정적 파일은 계속 제공');
    await srv.stop();
  });

  test('JASO_CLAUDE_BIN 이 없는 명령이면 health 에 "claude CLI를 찾을 수 없습니다", sample 은 503', async () => {
    const srv = await startServer({ JASO_CLAUDE_BIN: path.join(tmpRoot, 'no-such-claude-binary') });
    const h = await health(srv.url);
    assert.equal(h.login.ok, false); assert.equal(h.login.detail, 'claude CLI를 찾을 수 없습니다');
    assert.equal((await post(srv.url, { input: PROMPT })).status, 503);
    await srv.stop();
  });

  test('JASO_ACCESS_KEY 없이 JASO_ALLOW_ANON 도 아니면 코드 2 로 종료하며 한국어 안내를 낸다', async () => {
    const proc = spawn(process.execPath, [SERVER], { env: { PATH: process.env.PATH, HOME: process.env.HOME, JASO_PORT: '0', JASO_CLAUDE_BIN: FAKE, JASO_LOGIN_PROBE: '0' }, stdio: ['ignore', 'pipe', 'pipe'] });
    let err = '';
    proc.stderr.on('data', (d) => { err += d; });
    const code = await new Promise((r) => proc.on('exit', r));
    assert.equal(code, 2);
    assert.match(err, /JASO_ACCESS_KEY/); assert.match(err, /JASO_ALLOW_ANON=1/);
  });

  test('SIGTERM 으로 깨끗하게 종료한다 (코드 0)', async () => {
    const srv = await startServer({});
    assert.equal((await health(srv.url)).service, 'jaso');
    const code = await srv.stop();
    assert.equal(code, 0);
  });
});
