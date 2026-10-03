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
import crypto from 'node:crypto';
import {
  SYSTEM_PROMPT, TIERS, ERROR_TEXT, MIME, parseConfig, flattenInput, unflattenInput, buildArgs, childEnv, spawnSpec,
  createStreamParser, classifyFailure, checkAuth, keyDigest, createRateLimiter, resolveStatic, mimeFor, clientIp,
  errorMessage, sanitizeStderr, pickText, modelIdFrom, makeFailure, RequestError,
} from '../jaso/server/lib.mjs';
import {
  CONTENT_FLAGS, GUARD_MODES, isFlagOn, findEnvBlocks, parseRemoteManaged, parseGuardMode, scanTelemetry, shouldRefuse, flagKeys,
  createTelemetryGuard,
} from '../jaso/server/telemetry-guard.mjs';
import {
  SYNC_ID_RE, SYNC_PAYLOAD_RE, etagOf, parseEtagList, etagMatches, quoteEtag, validateSyncBody, createSyncStore,
} from '../jaso/server/sync.mjs';

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
  // Funnel 뒤: 방문자가 넣은 CF-Connecting-IP 는 무시하고 Funnel 이 넣은 X-Forwarded-For 를 쓴다 (IP 별 제한 우회 방지)
  const funnel = (extra) => ({ headers: { 'tailscale-funnel-request': '?1', 'x-forwarded-for': '203.0.113.20', 'x-forwarded-proto': 'https', ...extra }, socket: { remoteAddress: '127.0.0.1' } });
  assert.equal(clientIp(funnel({ 'cf-connecting-ip': '198.51.100.99' }), true), '203.0.113.20', 'Funnel 요청의 CF-Connecting-IP 는 위조 가능');
  assert.equal(clientIp(funnel({}), true), '203.0.113.20');
  assert.equal(clientIp(funnel({}), false), '127.0.0.1', '프록시를 믿지 않으면 소켓 주소');
  assert.equal(clientIp({ headers: { 'cf-connecting-ip': '198.51.100.7', 'x-forwarded-for': '203.0.113.20' }, socket: { remoteAddress: '127.0.0.1' } }, true), '198.51.100.7', 'Cloudflare 터널은 그대로 CF-Connecting-IP');
});

// ───────────── 텔레메트리 가드 (단위) ─────────────

const unitTmp = fs.mkdtempSync(path.join(os.tmpdir(), 'jaso-guard-unit-'));
after(() => { fs.rmSync(unitTmp, { recursive: true, force: true }); });
const NO_MANAGED = path.join(unitTmp, 'no-managed-settings.json');

/** 임시 설정 폴더 + 파일들 → 절대 경로 */
function unitDir(name, files = {}) {
  const dir = path.join(unitTmp, name);
  fs.mkdirSync(dir, { recursive: true });
  for (const [f, content] of Object.entries(files)) fs.writeFileSync(path.join(dir, f), typeof content === 'string' ? content : JSON.stringify(content));
  return dir;
}

test('findEnvBlocks: 최상위·감싼 형태·배열 속 env 객체를 경로와 함께 모두 찾고, 문자열 env·순환은 무시한다', () => {
  assert.deepEqual(findEnvBlocks(null), []);
  assert.deepEqual(findEnvBlocks('x'), []);
  assert.deepEqual(findEnvBlocks({ env: 'not-an-object' }), []);
  assert.deepEqual(findEnvBlocks({ env: ['a'] }), []);
  const j = {
    env: { A: '1' },
    settings: { env: { B: '2' }, permissions: { allow: [] } },
    data: { items: [{ env: { C: '3' } }, { other: 1 }] },
    nested: { deep: { deeper: { env: { D: '4' } } } },
  };
  const blocks = findEnvBlocks(j);
  assert.deepEqual(blocks.map((b) => b.path), ['env', 'settings.env', 'data.items[0].env', 'nested.deep.deeper.env']);
  assert.deepEqual(blocks.map((b) => Object.keys(b.env)[0]), ['A', 'B', 'C', 'D']);
  const cyc = { settings: {} };
  cyc.settings.self = cyc;
  cyc.settings.env = { E: '5' };
  assert.deepEqual(findEnvBlocks(cyc).map((b) => b.path), ['settings.env']);
});

test('isFlagOn / parseRemoteManaged / parseGuardMode / shouldRefuse / flagKeys', () => {
  for (const off of ['', '0', 'false', 'FALSE', 'off', ' Off ', 'no', undefined, null, false, 0]) assert.equal(isFlagOn(off), false, `꺼짐이어야 함: ${JSON.stringify(off)}`);
  for (const on of ['1', 'true', 'yes', 'on', 'file:/var/log/claude', 'anything', true, 1, {}]) assert.equal(isFlagOn(on), true, `켜짐이어야 함: ${JSON.stringify(on)}`);
  assert.deepEqual(CONTENT_FLAGS, ['OTEL_LOG_USER_PROMPTS', 'OTEL_LOG_ASSISTANT_RESPONSES', 'OTEL_LOG_TOOL_DETAILS', 'OTEL_LOG_TOOL_CONTENT', 'OTEL_LOG_RAW_API_BODIES']);
  assert.equal(parseRemoteManaged('Claude Code Doctor\n  Managed settings (remote): loaded\n  Organization policy: Loaded from api.anthropic.com\n'), 'loaded');
  assert.equal(parseRemoteManaged('managed settings (REMOTE):   Loaded.'), 'loaded');
  assert.equal(parseRemoteManaged('Managed settings (remote): none'), 'none');
  assert.equal(parseRemoteManaged('Managed settings (remote): not-configured'), 'none');
  assert.equal(parseRemoteManaged('Organization policy: Loaded'), 'unknown');
  assert.equal(parseRemoteManaged(null), 'unknown');
  assert.equal(parseRemoteManaged(''), 'unknown');
  assert.deepEqual(GUARD_MODES, ['block', 'strict', 'warn', 'off']);
  assert.equal(parseGuardMode(undefined), 'block'); assert.equal(parseGuardMode(' STRICT '), 'strict'); assert.equal(parseGuardMode('bogus'), 'block'); assert.equal(parseGuardMode('off'), 'off');
  const table = [
    ['block', 'blocked', true], ['block', 'unknown', false], ['block', 'clear', false],
    ['strict', 'blocked', true], ['strict', 'unknown', true], ['strict', 'clear', false],
    ['warn', 'blocked', false], ['warn', 'unknown', false], ['off', 'blocked', false], ['bogus', 'blocked', true],
  ];
  for (const [mode, status, want] of table) assert.equal(shouldRefuse(mode, status), want, `${mode}/${status}`);
  assert.deepEqual(flagKeys([{ key: 'A' }, { key: 'B' }, { key: 'A' }]), ['A', 'B']);
  assert.deepEqual(flagKeys(undefined), []);
});

test('scanTelemetry 표: clear · 원격 캐시/관리 파일/settings.json/프로세스 env 로 blocked · loaded+캐시 없음은 unknown · 꺼짐 값은 clear', () => {
  const base = { env: {}, managedFile: NO_MANAGED, now: () => 777 };

  const clear = scanTelemetry({ ...base, configDir: unitDir('clear'), doctorOutput: 'Managed settings (remote): none' });
  assert.equal(clear.status, 'clear'); assert.deepEqual(clear.flags, []); assert.equal(clear.remoteManaged, 'none'); assert.equal(clear.checkedAt, 777);
  assert.deepEqual(clear.sources.map((s) => [s.name, s.present, s.parseError]), [['remote-settings.json', false, false], ['managed-settings.json', false, false], ['settings.json', false, false], ['process env', true, false]]);

  const remote = scanTelemetry({ ...base, configDir: unitDir('remote', { 'remote-settings.json': { settings: { env: { OTEL_LOG_USER_PROMPTS: '1', OTEL_METRICS_EXPORTER: 'otlp' } } } }), doctorOutput: 'Managed settings (remote): loaded' });
  assert.equal(remote.status, 'blocked');
  assert.deepEqual(remote.flags, [{ key: 'OTEL_LOG_USER_PROMPTS', value: '<on>', source: 'remote-settings.json' }], '메타데이터 텔레메트리(OTEL_METRICS_EXPORTER)는 플래그가 아니다');
  assert.equal(remote.sources[0].present, true); assert.equal(remote.remoteManaged, 'loaded');

  const managedFile = path.join(unitTmp, 'managed-settings.json');
  fs.writeFileSync(managedFile, JSON.stringify({ env: { OTEL_LOG_RAW_API_BODIES: 'file:/home/op/secret-dir' } }));
  const managed = scanTelemetry({ ...base, managedFile, configDir: unitDir('managed'), doctorOutput: null });
  assert.equal(managed.status, 'blocked');
  assert.deepEqual(managed.flags, [{ key: 'OTEL_LOG_RAW_API_BODIES', value: '<on>', source: 'managed-settings.json' }]);
  assert.ok(!JSON.stringify(managed.flags).includes('secret-dir'), '값(경로)은 절대 그대로 넣지 않는다');
  assert.equal(managed.remoteManaged, 'unknown');

  const user = scanTelemetry({ ...base, configDir: unitDir('user', { 'settings.json': { env: { OTEL_LOG_ASSISTANT_RESPONSES: 'true' } } }) });
  assert.equal(user.status, 'blocked'); assert.equal(user.flags[0].source, 'settings.json');

  const procEnv = scanTelemetry({ ...base, env: { OTEL_LOG_TOOL_CONTENT: 'yes', OTEL_LOG_TOOL_DETAILS: '0', HOME: '/h' }, configDir: unitDir('procenv') });
  assert.equal(procEnv.status, 'blocked');
  assert.deepEqual(procEnv.flags, [{ key: 'OTEL_LOG_TOOL_CONTENT', value: '<on>', source: 'process env' }]);

  const unknown = scanTelemetry({ ...base, configDir: unitDir('unknown'), doctorOutput: 'Managed settings (remote): loaded' });
  assert.equal(unknown.status, 'unknown'); assert.deepEqual(unknown.flags, []); assert.equal(unknown.remoteManaged, 'loaded');
  const broken = scanTelemetry({ ...base, configDir: unitDir('broken', { 'remote-settings.json': '{not json' }), doctorOutput: 'Managed settings (remote): loaded' });
  assert.equal(broken.status, 'unknown', '캐시가 있어도 해석 불가면 unknown'); assert.equal(broken.sources[0].parseError, true); assert.equal(broken.sources[0].present, true);
  const loadedClean = scanTelemetry({ ...base, configDir: unitDir('loadedclean', { 'remote-settings.json': { env: { OTEL_LOG_USER_PROMPTS: '0' } } }), doctorOutput: 'Managed settings (remote): loaded' });
  assert.equal(loadedClean.status, 'clear', 'loaded 라도 캐시를 읽어 플래그가 꺼져 있으면 clear');
  const noDoctorNoCache = scanTelemetry({ ...base, configDir: unitDir('nodoctor'), doctorOutput: null });
  assert.equal(noDoctorNoCache.status, 'clear', 'doctor 를 못 읽었고 캐시도 없으면(원격 관리 알 수 없음) clear');

  const offValues = scanTelemetry({ ...base, configDir: unitDir('offvalues', { 'remote-settings.json': { env: { OTEL_LOG_USER_PROMPTS: '0', OTEL_LOG_ASSISTANT_RESPONSES: 'false', OTEL_LOG_TOOL_DETAILS: 'OFF', OTEL_LOG_TOOL_CONTENT: ' no ', OTEL_LOG_RAW_API_BODIES: '' } } }), doctorOutput: 'Managed settings (remote): loaded' });
  assert.equal(offValues.status, 'clear'); assert.deepEqual(offValues.flags, []);

  const both = scanTelemetry({ ...base, env: { OTEL_LOG_USER_PROMPTS: '1' }, configDir: unitDir('both', { 'remote-settings.json': '{bad' }), doctorOutput: 'Managed settings (remote): loaded' });
  assert.equal(both.status, 'blocked', 'blocked 가 unknown 보다 우선');
});

test('createTelemetryGuard: 시작 검사 → 상태 변화 로그, refuse/health, 파일 변경 감시, off 는 null', async () => {
  const lines = [];
  const log = { info: (...a) => lines.push(['info', a.join(' ')]), warn: (...a) => lines.push(['warn', a.join(' ')]), error: (...a) => lines.push(['error', a.join(' ')]) };
  const dir = unitDir('guard');
  let doctorCalls = 0;
  const guard = createTelemetryGuard({ mode: 'block', configDir: dir, managedFile: NO_MANAGED, recheckMs: 3600000, env: {}, log, debounceMs: 50, runDoctor: async () => { doctorCalls += 1; return 'Managed settings (remote): none'; } });
  await guard.start();
  assert.equal(doctorCalls, 1);
  assert.equal(guard.state.status, 'clear'); assert.equal(guard.refuse(), false);
  assert.deepEqual(Object.keys(guard.health()).sort(), ['cacheFile', 'checkedAt', 'flags', 'mode', 'remoteManaged', 'status']);
  assert.deepEqual([guard.health().mode, guard.health().status, guard.health().cacheFile, guard.health().remoteManaged], ['block', 'clear', 'absent', 'none']);
  assert.equal(lines.length, 1, '첫 검사는 항상 한 줄 남긴다'); assert.match(lines[0][1], /텔레메트리 가드\[block\].*→ clear/);

  // 파일 변경 감시: 캐시 파일이 생기면 디바운스 뒤 다시 검사해 blocked 가 된다
  fs.writeFileSync(path.join(dir, 'remote-settings.json'), JSON.stringify({ env: { OTEL_LOG_USER_PROMPTS: '1' } }));
  for (let i = 0; i < 60 && guard.state.status !== 'blocked'; i++) await new Promise((r) => setTimeout(r, 50));
  assert.equal(guard.state.status, 'blocked', 'fs.watch 로 변경을 감지해야 함');
  assert.equal(guard.refuse(), true);
  assert.deepEqual(guard.health().flags, ['OTEL_LOG_USER_PROMPTS']); assert.equal(guard.health().cacheFile, 'present');
  assert.equal(lines.length, 2); assert.equal(lines[1][0], 'warn'); assert.match(lines[1][1], /clear → blocked \(OTEL_LOG_USER_PROMPTS@remote-settings\.json\)/);
  assert.ok(!JSON.stringify(guard.health()).includes(dir), 'health 에 경로 없음');
  // 같은 상태의 재검사는 로그를 더 남기지 않는다
  await guard.rescan();
  assert.equal(lines.length, 2);
  // 다시 지우면 clear 로 돌아온다
  fs.unlinkSync(path.join(dir, 'remote-settings.json'));
  for (let i = 0; i < 60 && guard.state.status !== 'clear'; i++) await new Promise((r) => setTimeout(r, 50));
  assert.equal(guard.state.status, 'clear'); assert.equal(lines.length, 3);
  guard.stop();

  // strict: loaded + 캐시 없음 → unknown 거부, block 은 허용
  const strict = createTelemetryGuard({ mode: 'strict', configDir: unitDir('guard-strict'), managedFile: NO_MANAGED, env: {}, runDoctor: async () => 'Managed settings (remote): loaded' });
  await strict.start();
  assert.equal(strict.state.status, 'unknown'); assert.equal(strict.refuse(), true); strict.stop();
  const block = createTelemetryGuard({ mode: 'block', configDir: unitDir('guard-block'), managedFile: NO_MANAGED, env: {}, runDoctor: async () => 'Managed settings (remote): loaded' });
  await block.start();
  assert.equal(block.state.status, 'unknown'); assert.equal(block.refuse(), false); block.stop();
  // 한 번 'loaded' 를 읽은 뒤 doctor 가 실패(null·던짐·엉뚱한 출력)해도 이전 결과를 유지 → strict 는 계속 거부 (실패 시 열리지 않음)
  const doctorOuts = ['Managed settings (remote): loaded', null, 'boom', new Error('timeout')];
  const flakyLines = [];
  const flaky = createTelemetryGuard({
    mode: 'strict', configDir: unitDir('guard-flaky'), managedFile: NO_MANAGED, env: {},
    log: { info: () => {}, warn: (...a) => flakyLines.push(a.join(' ')), error: () => {} },
    runDoctor: async () => { const v = doctorOuts.shift(); if (v instanceof Error) throw v; return v; },
  });
  await flaky.start();
  assert.deepEqual([flaky.state.status, flaky.state.remoteManaged, flaky.refuse()], ['unknown', 'loaded', true]);
  for (let i = 0; i < 3; i++) {
    await flaky.rescan('주기 재검사');
    assert.deepEqual([flaky.state.status, flaky.state.remoteManaged, flaky.refuse()], ['unknown', 'loaded', true], `doctor 실패 ${i + 1}회째에도 strict 거부 유지`);
  }
  assert.ok(flakyLines.some((l) => /이전 결과를 유지/.test(l)), '경고 로그');
  // 새 doctor 결과가 제대로 오면 그것을 따른다
  doctorOuts.push('Managed settings (remote): none');
  await flaky.rescan('주기 재검사');
  assert.deepEqual([flaky.state.status, flaky.state.remoteManaged, flaky.refuse()], ['clear', 'none', false]);
  flaky.stop();
  // doctor 가 던져도 검사는 계속된다
  const throwing = createTelemetryGuard({ mode: 'block', configDir: unitDir('guard-throw'), managedFile: NO_MANAGED, env: { OTEL_LOG_USER_PROMPTS: 'on' }, runDoctor: async () => { throw new Error('nope'); } });
  await throwing.start();
  assert.equal(throwing.state.status, 'blocked'); assert.equal(throwing.state.remoteManaged, 'unknown'); throwing.stop();
  // off: 검사도 doctor 도 하지 않고 health 는 null
  let offCalls = 0;
  const off = createTelemetryGuard({ mode: 'off', configDir: dir, env: { OTEL_LOG_USER_PROMPTS: '1' }, runDoctor: async () => { offCalls += 1; return ''; } });
  await off.start();
  assert.equal(offCalls, 0); assert.equal(off.health(), null); assert.equal(off.refuse(), false); assert.equal(off.state.status, null); off.stop();
  // 설정 폴더가 없어도 시작은 된다
  const missing = createTelemetryGuard({ mode: 'block', configDir: path.join(unitTmp, 'does-not-exist'), managedFile: NO_MANAGED, env: {}, runDoctor: async () => null });
  await missing.start();
  assert.equal(missing.state.status, 'clear'); assert.equal(missing.health().cacheFile, 'absent'); missing.stop();
});

test('parseConfig/childEnv/MIME/ERROR_TEXT: 가드·동기화 설정 기본값, 통과 목록은 OTEL 본문 플래그를 거절, .webmanifest, telemetry_blocked 문구', () => {
  const d = parseConfig({ HOME: '/h' });
  assert.equal(d.telemetryGuard, 'block'); assert.equal(d.claudeConfigDir, '/h/.claude'); assert.equal(d.telemetryRecheckMs, 3600000); assert.equal(d.managedSettingsFile, '/etc/claude-code/managed-settings.json');
  assert.equal(d.dataDir, path.join(os.homedir(), '.local', 'share', 'jaso', 'sync'));
  assert.equal(d.syncEnabled, true); assert.equal(d.syncMaxBytes, 2097152); assert.equal(d.syncMaxItems, 200); assert.equal(d.syncTtlDays, 180); assert.equal(d.syncRateLimit, '120/600');
  assert.deepEqual(d.childEnvPassthroughRefused, []);
  assert.equal(parseConfig({ HOME: '/h', CLAUDE_CONFIG_DIR: '/cc' }).claudeConfigDir, '/cc', 'CLAUDE_CONFIG_DIR 를 따른다');
  assert.equal(parseConfig({ HOME: '/h', CLAUDE_CONFIG_DIR: '/cc', JASO_CLAUDE_CONFIG_DIR: '/x' }).claudeConfigDir, '/x', 'JASO_CLAUDE_CONFIG_DIR 가 우선');
  const c = parseConfig({ HOME: '/h', JASO_TELEMETRY_GUARD: ' STRICT ', JASO_TELEMETRY_RECHECK_MS: '10', JASO_MANAGED_SETTINGS_FILE: '/m.json', JASO_DATA_DIR: '/data/sync/', JASO_SYNC: '0', JASO_SYNC_MAX_BYTES: '100', JASO_SYNC_MAX_ITEMS: '1', JASO_SYNC_TTL_DAYS: '0', JASO_SYNC_RATE_LIMIT: '5/60', JASO_CHILD_ENV_PASSTHROUGH: 'FAKE_MODE,OTEL_LOG_USER_PROMPTS, OTEL_LOG_RAW_API_BODIES ANTHROPIC_API_KEY,HTTPS_PROXY' });
  assert.equal(c.telemetryGuard, 'strict'); assert.equal(c.telemetryRecheckMs, 3600000, '1초 미만은 기본값'); assert.equal(c.managedSettingsFile, '/m.json'); assert.equal(c.dataDir, '/data/sync');
  assert.equal(c.syncEnabled, false); assert.equal(c.syncMaxBytes, 100); assert.equal(c.syncMaxItems, 1); assert.equal(c.syncTtlDays, 0); assert.equal(c.syncRateLimit, '5/60');
  assert.deepEqual(c.childEnvPassthrough, ['FAKE_MODE', 'HTTPS_PROXY']);
  assert.deepEqual(c.childEnvPassthroughRefused, ['OTEL_LOG_USER_PROMPTS', 'OTEL_LOG_RAW_API_BODIES', 'ANTHROPIC_API_KEY']);
  assert.equal(parseConfig({ JASO_TELEMETRY_GUARD: 'bogus' }).telemetryGuard, 'block');
  assert.equal(parseConfig({ JASO_SYNC: '1' }).syncEnabled, true);
  const env = { HOME: '/h', PATH: '/bin', FAKE_MODE: 'x', OTEL_LOG_USER_PROMPTS: '1', OTEL_LOG_ASSISTANT_RESPONSES: '1', OTEL_LOG_TOOL_DETAILS: '1', OTEL_LOG_TOOL_CONTENT: '1', OTEL_LOG_RAW_API_BODIES: 'file:/x', OTEL_METRICS_EXPORTER: 'otlp' };
  const ce = childEnv(env, parseConfig({ JASO_CHILD_ENV_PASSTHROUGH: CONTENT_FLAGS.join(',') + ',FAKE_MODE' }));
  for (const k of CONTENT_FLAGS) assert.equal(ce[k], undefined, `${k} 는 통과 목록에 있어도 자식에 가지 않는다`);
  assert.equal(ce.FAKE_MODE, 'x'); assert.equal(ce.OTEL_METRICS_EXPORTER, undefined, '화이트리스트 밖');
  assert.equal(MIME['.webmanifest'], 'application/manifest+json'); assert.equal(mimeFor('/jaso/manifest.webmanifest'), 'application/manifest+json');
  assert.equal(mimeFor('icon.png'), 'image/png'); assert.equal(mimeFor('icon.svg'), 'image/svg+xml');
  assert.equal(ERROR_TEXT.telemetry_blocked, '운영자 조직의 Claude 텔레메트리 설정이 프롬프트·답변 본문 수집을 켜 두어 호출을 중단했습니다. 운영자에게 알려 주세요.');
  assert.equal(ERROR_TEXT.sync_full, '서버의 동기화 저장 공간이 가득 찼습니다. 운영자에게 알려 주세요.');
  assert.ok(ERROR_TEXT.sync_conflict.length > 0);
  const f = makeFailure(503, 'telemetry_blocked', { flags: ['OTEL_LOG_USER_PROMPTS'] });
  assert.deepEqual(f, { status: 503, code: 'telemetry_blocked', message: ERROR_TEXT.telemetry_blocked, flags: ['OTEL_LOG_USER_PROMPTS'] });
  // strict 의 unknown 거부: 같은 코드, "수집이 켜졌다"고 하지 않는 문구
  assert.equal(ERROR_TEXT.telemetry_unverified, '운영자 조직의 텔레메트리 설정을 확인할 수 없어(엄격 모드) 호출을 중단했습니다. 운영자에게 알려 주세요.');
  assert.deepEqual(makeFailure(503, 'telemetry_blocked', { flags: [], guardStatus: 'unknown' }), { status: 503, code: 'telemetry_blocked', message: ERROR_TEXT.telemetry_unverified, flags: [], guardStatus: 'unknown' });
  assert.equal(makeFailure(503, 'telemetry_blocked', { flags: [], guardStatus: 'blocked' }).message, ERROR_TEXT.telemetry_blocked);
  assert.ok(ERROR_TEXT.sync_missing.length > 0);
  assert.equal(makeFailure(503, 'busy').flags, undefined);
});

// ───────────── 동기화 저장소 (단위) ─────────────

test('sync 헬퍼: etagOf, ETag 헤더 해석(따옴표·W/·목록·*), 본문 검증(400/413)', () => {
  assert.equal(etagOf('AQID'), crypto.createHash('sha256').update('AQID').digest('hex').slice(0, 32));
  assert.equal(etagOf('AQID').length, 32);
  assert.ok(SYNC_ID_RE.test('0123456789abcdef0123456789abcdef')); assert.ok(!SYNC_ID_RE.test('0123456789ABCDEF0123456789abcdef')); assert.ok(!SYNC_ID_RE.test('abc'));
  assert.ok(SYNC_PAYLOAD_RE.test('AQID_-x')); assert.ok(!SYNC_PAYLOAD_RE.test('AQ+D')); assert.ok(!SYNC_PAYLOAD_RE.test('AQ=')); assert.ok(!SYNC_PAYLOAD_RE.test(''));
  assert.deepEqual(parseEtagList('"abc"'), ['abc']); assert.deepEqual(parseEtagList('W/"abc", "def"'), ['abc', 'def']); assert.deepEqual(parseEtagList(['"a"', '"b"']), ['a', 'b']);
  assert.deepEqual(parseEtagList(undefined), []); assert.deepEqual(parseEtagList('  '), []); assert.deepEqual(parseEtagList('abc'), ['abc']);
  assert.equal(etagMatches('"abc"', 'abc'), true); assert.equal(etagMatches('W/"abc"', 'abc'), true); assert.equal(etagMatches('"x", "abc"', 'abc'), true);
  assert.equal(etagMatches('*', 'abc'), true); assert.equal(etagMatches('"abd"', 'abc'), false); assert.equal(etagMatches(undefined, 'abc'), false); assert.equal(etagMatches('"abc"', ''), false);
  assert.equal(quoteEtag('abc'), '"abc"');
  assert.deepEqual(validateSyncBody(Buffer.from(JSON.stringify({ payload: 'AQID', updatedAt: 1234.7 })), 100), { payload: 'AQID', updatedAt: 1234, bytes: 4 });
  const bad = (raw, status, hint) => assert.throws(() => validateSyncBody(raw, 100), (e) => e instanceof RequestError && e.status === status, hint);
  bad('{nope', 400, 'JSON 아님'); bad('[1]', 400, '배열'); bad(JSON.stringify({ updatedAt: 1 }), 400, 'payload 없음'); bad(JSON.stringify({ payload: '', updatedAt: 1 }), 400, '빈 payload');
  bad(JSON.stringify({ payload: 'AQ+D', updatedAt: 1 }), 400, 'base64url 아님'); bad(JSON.stringify({ payload: 'AQID' }), 400, 'updatedAt 없음'); bad(JSON.stringify({ payload: 'AQID', updatedAt: '1' }), 400, 'updatedAt 문자열');
  bad(JSON.stringify({ payload: 'AQID', updatedAt: -1 }), 400, '음수'); bad(JSON.stringify({ payload: 'A'.repeat(101), updatedAt: 1 }), 413, '너무 큼');
  assert.equal(validateSyncBody(JSON.stringify({ payload: 'A'.repeat(100), updatedAt: 0 }), 100).bytes, 100);
});

test('createSyncStore: 0700 폴더, 원자적 저장(0600), get/put/If-Match 충돌/가득 참/삭제/만료 정리/깨진 파일', async () => {
  let t = 1_700_000_000_000;
  const dir = path.join(unitTmp, 'store', 'nested');
  const store = createSyncStore({ dir, maxBytes: 100, maxItems: 2, ttlDays: 1, now: () => t });
  assert.equal(store.init(), 0);
  assert.equal(fs.statSync(dir).mode & 0o777, 0o700);
  const id1 = crypto.randomBytes(16).toString('hex');
  const id2 = crypto.randomBytes(16).toString('hex');
  const id3 = crypto.randomBytes(16).toString('hex');
  assert.equal(await store.get(id1), null);
  const r1 = await store.put(id1, { payload: 'AQID', updatedAt: 1000 });
  assert.equal(r1.ok, true);
  assert.deepEqual(r1.record, { id: id1, etag: etagOf('AQID'), updatedAt: 1000, payload: 'AQID', bytes: 4, storedAt: t });
  const file = path.join(dir, `${id1}.json`);
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.deepEqual(Object.keys(JSON.parse(fs.readFileSync(file, 'utf8'))).sort(), ['bytes', 'etag', 'id', 'payload', 'storedAt', 'updatedAt']);
  assert.deepEqual(await store.get(id1), r1.record);
  assert.equal(store.count(), 1);
  const conflict = await store.put(id1, { payload: 'BBBB', updatedAt: 2000, ifMatch: 'wrong-etag' });
  assert.deepEqual([conflict.ok, conflict.code, conflict.record.etag, conflict.record.payload], [false, 'sync_conflict', etagOf('AQID'), 'AQID']);
  assert.equal((await store.get(id1)).payload, 'AQID', '충돌이면 덮어쓰지 않는다');
  const ok2 = await store.put(id1, { payload: 'BBBB', updatedAt: 2000, ifMatch: etagOf('AQID') });
  assert.equal(ok2.ok, true); assert.equal(ok2.record.etag, etagOf('BBBB')); assert.equal((await store.get(id1)).payload, 'BBBB');
  const missing = await store.put(id2, { payload: 'CCCC', updatedAt: 1, ifMatch: 'stale' });
  assert.deepEqual([missing.ok, missing.code, missing.record], [false, 'sync_missing', null], 'If-Match 를 걸었는데 레코드가 없으면(다른 기기가 삭제·만료) 다시 만들지 않는다');
  assert.equal(await store.get(id2), null); assert.equal(store.count(), 1);
  assert.equal((await store.put(id2, { payload: 'CCCC', updatedAt: 1 })).ok, true, 'If-Match 없이는 새로 만든다');
  assert.equal(store.count(), 2);
  const full = await store.put(id3, { payload: 'DDDD', updatedAt: 1 });
  assert.deepEqual([full.ok, full.code], [false, 'sync_full']);
  assert.equal((await store.put(id2, { payload: 'EEEE', updatedAt: 2 })).ok, true, '기존 id 갱신은 가득 차도 된다');
  await assert.rejects(store.put(id1, { payload: 'A'.repeat(101), updatedAt: 1 }), (e) => e instanceof RequestError && e.status === 413);
  assert.throws(() => store.put('bad', { payload: 'A', updatedAt: 1 }), (e) => e instanceof RequestError && e.status === 400);
  assert.equal(await store.remove(id2), true); assert.equal(await store.remove(id2), false, '없어도 조용히'); assert.equal(await store.get(id2), null);
  assert.equal(store.count(), 1);
  assert.equal((await store.put(id3, { payload: 'DDDD', updatedAt: 1 })).ok, true);
  // 동시에 같은 id 로 쓰면 마지막 쓰기가 남고 파일은 깨지지 않는다
  await Promise.all(['X1', 'X2', 'X3'].map((p, i) => store.put(id3, { payload: p, updatedAt: i })));
  assert.equal((await store.get(id3)).payload, 'X3');
  assert.ok(!fs.readdirSync(dir).some((n) => n.endsWith('.tmp')), '임시 파일이 남지 않는다');
  // 다시 열면 개수를 센다
  const reopened = createSyncStore({ dir, maxBytes: 100, maxItems: 2, ttlDays: 1, now: () => t });
  assert.equal(reopened.init(), 2);
  // 만료 정리: 하루 지난 레코드와 깨진 파일을 지운다
  fs.writeFileSync(path.join(dir, `${'f'.repeat(32)}.json`), '{broken');
  fs.writeFileSync(path.join(dir, 'leftover.json.123.tmp'), 'x');
  assert.equal(store.init(), 3, '.tmp 는 치우고 깨진 파일은 일단 센다');
  assert.ok(!fs.existsSync(path.join(dir, 'leftover.json.123.tmp')));
  assert.equal(await store.sweep(t + 3600000), 1, '깨진 파일만 지움');
  assert.equal(store.count(), 2);
  t += 2 * 86400000;
  // 가득 찬 상태(2/2)라 새 id 는 한도가 넉넉한 다른 인스턴스로 넣는다 (같은 폴더)
  const roomy = createSyncStore({ dir, maxBytes: 100, maxItems: 10, ttlDays: 1, now: () => t });
  roomy.init();
  assert.equal((await roomy.put(id2, { payload: 'NEW', updatedAt: 5 })).ok, true);
  assert.equal(await store.sweep(), 2, '오래된 두 개만');
  assert.equal(store.count(), 1); assert.equal((await store.get(id2)).payload, 'NEW'); assert.equal(await store.get(id1), null);
  const noTtl = createSyncStore({ dir, ttlDays: 0, now: () => t + 365 * 86400000 });
  noTtl.init();
  assert.equal(await noTtl.sweep(), 0, 'ttlDays=0 이면 만료 없음');
});

// ───────────── 통합: 서버를 자식 프로세스로 띄운다 ─────────────

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'jaso-server-test-'));
const servers = new Set();
// 기본 Claude 설정 폴더는 비어 있는 임시 폴더, 관리 설정 파일은 없는 경로 → 테스트 기계의 ~/.claude 나 /etc 가 결과에 끼어들지 않는다
const cleanConfigDir = path.join(tmpRoot, 'claude-clean');
fs.mkdirSync(cleanConfigDir, { recursive: true });
let dataDirSeq = 0;

/** 임시 Claude 설정 폴더를 만들고 파일들을 쓴다 → 절대 경로 */
function mkConfigDir(name, files = {}) {
  const dir = path.join(tmpRoot, `claude-${name}`);
  fs.mkdirSync(dir, { recursive: true });
  for (const [f, content] of Object.entries(files)) fs.writeFileSync(path.join(dir, f), typeof content === 'string' ? content : JSON.stringify(content));
  return dir;
}

async function startServer(extra = {}) {
  dataDirSeq += 1;
  const env = {
    PATH: process.env.PATH, HOME: process.env.HOME, LANG: process.env.LANG ?? 'C.UTF-8',
    JASO_PORT: '0', JASO_ACCESS_KEY: 'k', JASO_LOGIN_PROBE: '0', JASO_CLAUDE_BIN: FAKE,
    JASO_CHILD_ENV_PASSTHROUGH: 'FAKE_MODE,FAKE_DELAY_MS,FAKE_LOG,FAKE_RATE_STATUS,FAKE_LOGGED_IN,FAKE_REMOTE_MANAGED',
    JASO_WORK_DIR: path.join(tmpRoot, 'work'), JASO_LOG_LEVEL: 'silent',
    JASO_CLAUDE_CONFIG_DIR: cleanConfigDir, JASO_MANAGED_SETTINGS_FILE: path.join(tmpRoot, 'no-managed-settings.json'),
    JASO_DATA_DIR: path.join(tmpRoot, `sync-${dataDirSeq}`),
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
    assert.deepEqual(Object.keys(h.telemetry).sort(), ['cacheFile', 'checkedAt', 'flags', 'mode', 'remoteManaged', 'status']);
    assert.deepEqual([h.telemetry.mode, h.telemetry.status, h.telemetry.flags, h.telemetry.remoteManaged, h.telemetry.cacheFile], ['block', 'clear', [], 'none', 'absent']);
    assert.ok(h.telemetry.checkedAt > 0);
    assert.deepEqual(h.sync, { enabled: true, items: 0, maxBytes: 2097152 });
    assert.ok(!JSON.stringify(h).includes(tmpRoot), 'health 에 운영자 경로가 없다');
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

  // ───────────── 텔레메트리 가드 (통합) ─────────────

  const BLOCKING_CACHE = { env: { OTEL_LOG_USER_PROMPTS: '1' } };

  test('텔레메트리 가드: 원격 캐시가 본문 수집을 켜 두면 health blocked, sample 은 503 telemetry_blocked (CLI 실행 안 함); warn 은 허용, off 는 null', async () => {
    const dir = mkConfigDir('blocked', { 'remote-settings.json': BLOCKING_CACHE });
    const fakeLogB = path.join(tmpRoot, 'blocked.log');
    const srv = await startServer({ JASO_CLAUDE_CONFIG_DIR: dir, FAKE_LOG: fakeLogB, JASO_LOG_LEVEL: 'info' });
    const h = await health(srv.url);
    assert.deepEqual([h.telemetry.mode, h.telemetry.status, h.telemetry.flags, h.telemetry.remoteManaged, h.telemetry.cacheFile], ['block', 'blocked', ['OTEL_LOG_USER_PROMPTS'], 'none', 'present']);
    assert.ok(!JSON.stringify(h).includes(dir), 'health 에 운영자 경로 없음');
    const res = await post(srv.url, { input: PROMPT });
    assert.equal(res.status, 503);
    const j = await res.json();
    assert.deepEqual(j, { code: 'telemetry_blocked', message: ERROR_TEXT.telemetry_blocked, flags: ['OTEL_LOG_USER_PROMPTS'], guardStatus: 'blocked' });
    assert.equal(j.message, '운영자 조직의 Claude 텔레메트리 설정이 프롬프트·답변 본문 수집을 켜 두어 호출을 중단했습니다. 운영자에게 알려 주세요.');
    const st = await post(srv.url, { input: PROMPT, stream: true });
    assert.equal(st.status, 503, '스트리밍 요청도 본문을 읽기 전에 거절');
    assert.equal((await st.json()).code, 'telemetry_blocked');
    assert.ok(!fs.existsSync(fakeLogB), 'Claude CLI 를 호출하지 않는다');
    assert.equal((await fetch(`${srv.url}jaso/index.html`)).status, 200, '정적 파일은 계속 제공');
    assert.equal((await post(srv.url, { input: PROMPT }, { key: 'bad' })).status, 401, '인증이 가드보다 먼저');
    await srv.stop();
    assert.match(srv.stderr(), /텔레메트리 가드\[block\].*→ blocked \(OTEL_LOG_USER_PROMPTS@remote-settings\.json\)/, '상태 로그 한 줄');
    assert.ok(!srv.stderr().includes(dir), '로그에도 운영자 경로 없음');

    const warn = await startServer({ JASO_CLAUDE_CONFIG_DIR: dir, JASO_TELEMETRY_GUARD: 'warn' });
    const hw = await health(warn.url);
    assert.deepEqual([hw.telemetry.mode, hw.telemetry.status], ['warn', 'blocked']);
    assert.equal((await post(warn.url, { input: PROMPT })).status, 200, 'warn 은 거절하지 않는다');
    await warn.stop();

    const off = await startServer({ JASO_CLAUDE_CONFIG_DIR: dir, JASO_TELEMETRY_GUARD: 'off' });
    assert.equal((await health(off.url)).telemetry, null);
    assert.equal((await post(off.url, { input: PROMPT })).status, 200);
    await off.stop();

    const managed = await startServer({ JASO_MANAGED_SETTINGS_FILE: path.join(dir, 'remote-settings.json') });
    const hm = await health(managed.url);
    assert.deepEqual([hm.telemetry.status, hm.telemetry.cacheFile], ['blocked', 'absent'], '관리 설정 파일로도 차단');
    assert.equal((await post(managed.url, { input: PROMPT })).status, 503);
    await managed.stop();
  });

  test('텔레메트리 가드: 원격 관리 loaded 인데 캐시가 없으면 unknown — 기본(block)은 허용, strict 는 503', async () => {
    const srv = await startServer({ FAKE_REMOTE_MANAGED: 'loaded' });
    const h = await health(srv.url);
    assert.deepEqual([h.telemetry.status, h.telemetry.remoteManaged, h.telemetry.cacheFile, h.telemetry.flags], ['unknown', 'loaded', 'absent', []]);
    assert.equal((await post(srv.url, { input: PROMPT })).status, 200);
    await srv.stop();
    const strict = await startServer({ FAKE_REMOTE_MANAGED: 'loaded', JASO_TELEMETRY_GUARD: 'strict' });
    const hs = await health(strict.url);
    assert.deepEqual([hs.telemetry.mode, hs.telemetry.status], ['strict', 'unknown']);
    const res = await post(strict.url, { input: PROMPT });
    assert.equal(res.status, 503);
    assert.deepEqual(await res.json(), { code: 'telemetry_blocked', message: ERROR_TEXT.telemetry_unverified, flags: [], guardStatus: 'unknown' }, 'strict 의 unknown 은 "확인할 수 없어" 문구');
    await strict.stop();
    // 캐시가 있고 플래그가 꺼져 있으면 loaded 라도 clear
    const cleanLoaded = await startServer({ FAKE_REMOTE_MANAGED: 'loaded', JASO_CLAUDE_CONFIG_DIR: mkConfigDir('loaded-clean', { 'remote-settings.json': { settings: { env: { OTEL_LOG_USER_PROMPTS: 'false' } } } }) });
    const hc = await health(cleanLoaded.url);
    assert.deepEqual([hc.telemetry.status, hc.telemetry.remoteManaged, hc.telemetry.cacheFile], ['clear', 'loaded', 'present']);
    await cleanLoaded.stop();
  });

  test('텔레메트리 가드: 설정 폴더의 캐시 파일이 바뀌면 5초 안에 다시 검사한다', async () => {
    const dir = mkConfigDir('watch');
    const srv = await startServer({ JASO_CLAUDE_CONFIG_DIR: dir });
    assert.equal((await health(srv.url)).telemetry.status, 'clear');
    assert.equal((await post(srv.url, { input: PROMPT })).status, 200);
    fs.writeFileSync(path.join(dir, 'remote-settings.json'), JSON.stringify(BLOCKING_CACHE));
    const t0 = Date.now();
    let status = 'clear';
    while (Date.now() - t0 < 5000) {
      status = (await health(srv.url)).telemetry.status;
      if (status === 'blocked') break;
      await sleep(100);
    }
    assert.equal(status, 'blocked', '5초 안에 blocked 로 바뀌어야 함');
    assert.equal((await post(srv.url, { input: PROMPT })).status, 503);
    fs.unlinkSync(path.join(dir, 'remote-settings.json'));
    const t1 = Date.now();
    while (Date.now() - t1 < 5000) {
      status = (await health(srv.url)).telemetry.status;
      if (status === 'clear') break;
      await sleep(100);
    }
    assert.equal(status, 'clear', '지우면 다시 clear');
    assert.equal((await post(srv.url, { input: PROMPT })).status, 200);
    await srv.stop();
  }, { timeout: 30000 });

  test('텔레메트리 가드: 대기열에서 기다리는 동안 차단으로 바뀌면 CLI 를 띄우기 직전에 503 (대기하던 요청은 CLI 를 실행하지 않음)', async () => {
    const dir = mkConfigDir('queue-flip');
    const fakeLogQ = path.join(tmpRoot, 'queue-flip.log');
    const calls = () => (fs.existsSync(fakeLogQ) ? fs.readFileSync(fakeLogQ, 'utf8').trim().split('\n').filter(Boolean).length : 0);
    const waitFor = async (pred, ms, what) => {
      const t0 = Date.now();
      while (Date.now() - t0 < ms) { if (await pred()) return; await sleep(50); }
      assert.fail(`${ms}ms 안에 ${what}`);
    };
    // 첫 요청은 조각 사이에 오래 멈춰(FAKE_DELAY_MS) 하나뿐인 슬롯을 잡고 있다
    const srv = await startServer({ JASO_CLAUDE_CONFIG_DIR: dir, FAKE_LOG: fakeLogQ, FAKE_DELAY_MS: '20000' });
    const ac = new AbortController();
    const first = await post(srv.url, { input: PROMPT, stream: true }, { signal: ac.signal });
    assert.equal(first.status, 200);
    first.body.getReader().read().catch(() => {});
    await waitFor(() => calls() === 1, 5000, '첫 요청이 CLI 를 띄워야 함');
    // 두 번째(비스트리밍)·세 번째(스트리밍) 요청은 대기열에서 기다린다 — 이때는 아직 clear 라 입구 검사를 통과
    const second = post(srv.url, { input: PROMPT });
    const third = await post(srv.url, { input: PROMPT, stream: true });
    assert.equal(third.status, 200, '스트리밍 대기 요청은 queued 이벤트로 헤더가 먼저 나간다');
    const thirdText = third.text();
    await waitFor(async () => (await health(srv.url)).queue.waiting === 2, 5000, '두 요청이 대기열에 있어야 함');
    // 기다리는 사이에 조직 설정이 본문 수집을 켠다 → 파일 감시 재검사로 blocked
    fs.writeFileSync(path.join(dir, 'remote-settings.json'), JSON.stringify(BLOCKING_CACHE));
    await waitFor(async () => (await health(srv.url)).telemetry.status === 'blocked', 5000, 'blocked 로 바뀌어야 함');
    // 첫 요청을 끊으면 슬롯이 비고, 대기하던 요청들이 차례로 자리를 잡지만 CLI 를 띄우기 전에 다시 검사해 거절한다
    ac.abort();
    const r2 = await second;
    assert.equal(r2.status, 503);
    assert.deepEqual(await r2.json(), { code: 'telemetry_blocked', message: ERROR_TEXT.telemetry_blocked, flags: ['OTEL_LOG_USER_PROMPTS'], guardStatus: 'blocked' });
    const events = parseSSE(await thirdText);
    assert.equal(events[0].event, 'queued');
    const last = events[events.length - 1];
    assert.equal(last.event, 'error'); assert.equal(last.data.code, 'telemetry_blocked');
    assert.ok(!events.some((e) => e.event === 'delta' || e.event === 'done'));
    assert.equal(calls(), 1, '대기하던 요청은 CLI 를 실행하지 않는다');
    await waitFor(async () => { const q = (await health(srv.url)).queue; return q.active === 0 && q.waiting === 0; }, 5000, '슬롯이 모두 비어야 함');
    await srv.stop();
  }, { timeout: 30000 });

  test('JASO_CHILD_ENV_PASSTHROUGH 에 OTEL 본문 플래그가 있으면 경고를 남기고 자식에 넘기지 않는다', async () => {
    const srv = await startServer({ JASO_CHILD_ENV_PASSTHROUGH: 'FAKE_MODE,OTEL_LOG_USER_PROMPTS,OTEL_LOG_RAW_API_BODIES', JASO_LOG_LEVEL: 'info', OTEL_LOG_USER_PROMPTS: '0' });
    assert.equal((await health(srv.url)).telemetry.status, 'clear', '서버 env 의 꺼진 값은 차단 사유가 아니다');
    assert.equal((await post(srv.url, { input: PROMPT })).status, 200);
    await srv.stop();
    assert.match(srv.stderr(), /WARN .*JASO_CHILD_ENV_PASSTHROUGH.*OTEL_LOG_USER_PROMPTS, OTEL_LOG_RAW_API_BODIES/);
    const blocked = await startServer({ OTEL_LOG_USER_PROMPTS: '1' });
    assert.equal((await health(blocked.url)).telemetry.status, 'blocked', '서버 프로세스 env 의 켜진 플래그도 차단');
    assert.equal((await post(blocked.url, { input: PROMPT })).status, 503);
    await blocked.stop();
  });

  // ───────────── 동기화 API (통합) ─────────────

  const syncUrl = (url, id) => `${url}api/sync/${id}`;
  const syncPut = (url, id, body, { key = 'k', headers = {} } = {}) => fetch(syncUrl(url, id), {
    method: 'PUT',
    headers: { 'content-type': 'application/json', ...(key ? { authorization: `Bearer ${key}` } : {}), ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
  const syncGet = (url, id, { key = 'k', headers = {}, method = 'GET' } = {}) => fetch(syncUrl(url, id), { method, headers: { ...(key ? { authorization: `Bearer ${key}` } : {}), ...headers } });
  const newId = () => crypto.randomBytes(16).toString('hex');

  test('sync API: PUT/GET/ETag/304/If-Match 412/DELETE 204, 400 잘못된 id·payload, 401, 405', async () => {
    const id = newId();
    const miss = await syncGet(S.url, id);
    assert.equal(miss.status, 404); assert.deepEqual(await miss.json(), { code: 'not_found', message: ERROR_TEXT.not_found });

    const put1 = await syncPut(S.url, id, { payload: 'AQID', updatedAt: 1000 });
    assert.equal(put1.status, 200);
    const j1 = await put1.json();
    assert.deepEqual(j1, { id, etag: etagOf('AQID'), updatedAt: 1000 });
    assert.equal(put1.headers.get('etag'), `"${j1.etag}"`);
    assert.equal(put1.headers.get('cache-control'), 'no-store');
    assert.equal((await health(S.url)).sync.items, 1);

    const get1 = await syncGet(S.url, id);
    assert.equal(get1.status, 200);
    assert.equal(get1.headers.get('etag'), `"${j1.etag}"`);
    assert.equal(get1.headers.get('content-type'), 'application/json; charset=utf-8');
    assert.deepEqual(await get1.json(), { id, etag: j1.etag, updatedAt: 1000, payload: 'AQID' });
    const head = await syncGet(S.url, id, { method: 'HEAD' });
    assert.equal(head.status, 200); assert.equal(await head.text(), '');

    const nm = await syncGet(S.url, id, { headers: { 'if-none-match': `"${j1.etag}"` } });
    assert.equal(nm.status, 304); assert.equal(nm.headers.get('etag'), `"${j1.etag}"`); assert.equal(await nm.text(), '');
    assert.equal((await syncGet(S.url, id, { headers: { 'if-none-match': `W/"${j1.etag}"` } })).status, 304, '약한 비교도 일치');
    assert.equal((await syncGet(S.url, id, { headers: { 'if-none-match': '"stale"' } })).status, 200);

    const conflict = await syncPut(S.url, id, { payload: 'BBBB', updatedAt: 2000 }, { headers: { 'if-match': '"not-the-etag"' } });
    assert.equal(conflict.status, 412);
    const cj = await conflict.json();
    assert.deepEqual(cj, { code: 'sync_conflict', message: ERROR_TEXT.sync_conflict, etag: j1.etag, updatedAt: 1000, payload: 'AQID' });
    assert.equal(conflict.headers.get('etag'), `"${j1.etag}"`);
    assert.deepEqual((await (await syncGet(S.url, id)).json()).payload, 'AQID', '충돌이면 저장하지 않는다');

    const put2 = await syncPut(S.url, id, { payload: 'BBBB', updatedAt: 2000 }, { headers: { 'if-match': `"${j1.etag}"` } });
    assert.equal(put2.status, 200);
    const j2 = await put2.json();
    assert.deepEqual(j2, { id, etag: etagOf('BBBB'), updatedAt: 2000 });
    assert.deepEqual(await (await syncGet(S.url, id)).json(), { id, etag: j2.etag, updatedAt: 2000, payload: 'BBBB' });
    assert.equal((await syncPut(S.url, id, { payload: 'CCCC', updatedAt: 3000 }, { headers: { 'if-match': '*' } })).status, 200, '* 는 조건 없음');
    const otherId = newId();
    const gone = await syncPut(S.url, otherId, { payload: 'DDDD', updatedAt: 1 }, { headers: { 'if-match': '"stale"' } });
    assert.equal(gone.status, 412, 'If-Match 를 걸었는데 레코드가 없으면(다른 기기가 삭제·만료) 다시 만들지 않는다');
    assert.deepEqual(await gone.json(), { code: 'sync_missing', message: ERROR_TEXT.sync_missing });
    assert.equal((await syncGet(S.url, otherId)).status, 404);
    assert.equal((await syncPut(S.url, otherId, { payload: 'DDDD', updatedAt: 1 })).status, 200, 'If-Match 없으면 새로 만든다');
    assert.equal((await health(S.url)).sync.items, 2);

    const del = await syncGet(S.url, id, { method: 'DELETE' });
    assert.equal(del.status, 204); assert.equal(await del.text(), '');
    assert.equal((await syncGet(S.url, id, { method: 'DELETE' })).status, 204, '멱등');
    assert.equal((await syncGet(S.url, id)).status, 404);
    assert.equal((await health(S.url)).sync.items, 1);
    // 지운 레코드를 다른 기기가 옛 etag 로 다시 올리면 412 sync_missing (몰래 되살리지 않음)
    const revive = await syncPut(S.url, id, { payload: 'EEEE', updatedAt: 4000 }, { headers: { 'if-match': `"${etagOf('CCCC')}"` } });
    assert.equal(revive.status, 412); assert.equal((await revive.json()).code, 'sync_missing');
    assert.equal((await syncGet(S.url, id)).status, 404);
    assert.equal((await health(S.url)).sync.items, 1);

    // 400
    for (const badId of ['xyz', 'A'.repeat(32), 'g'.repeat(32), '0'.repeat(31), '0'.repeat(33), `${'0'.repeat(32)}.json`]) {
      const r = await syncGet(S.url, badId);
      assert.equal(r.status, 400, `잘못된 id: ${badId}`); assert.equal((await r.json()).code, 'invalid_request');
      assert.equal((await syncPut(S.url, badId, { payload: 'AQID', updatedAt: 1 })).status, 400);
    }
    for (const [body, hint] of [['{nope', 'JSON 아님'], [{ updatedAt: 1 }, 'payload 없음'], [{ payload: '', updatedAt: 1 }, '빈 payload'], [{ payload: 'AQ+D/', updatedAt: 1 }, 'base64url 아님'], [{ payload: 'AQID' }, 'updatedAt 없음'], [{ payload: 'AQID', updatedAt: 'x' }, 'updatedAt 문자열'], [{ payload: 123, updatedAt: 1 }, 'payload 숫자'], [[1], '배열']]) {
      const r = await syncPut(S.url, newId(), body);
      assert.equal(r.status, 400, `400 이어야 함: ${hint}`); assert.equal((await r.json()).code, 'invalid_request');
    }
    const ctype = await fetch(syncUrl(S.url, newId()), { method: 'PUT', headers: { 'content-type': 'text/plain', authorization: 'Bearer k' }, body: JSON.stringify({ payload: 'AQID', updatedAt: 1 }) });
    assert.equal(ctype.status, 400);
    assert.equal((await health(S.url)).sync.items, 1, '잘못된 요청은 저장되지 않는다');

    // 401 / 405 / 404
    const noKey = await syncGet(S.url, newId(), { key: '' });
    assert.equal(noKey.status, 401); assert.equal(noKey.headers.get('www-authenticate'), 'Bearer');
    assert.equal((await syncPut(S.url, newId(), { payload: 'AQID', updatedAt: 1 }, { key: 'wrong' })).status, 401);
    assert.equal((await syncGet(S.url, newId(), { method: 'DELETE', key: '' })).status, 401);
    const post405 = await fetch(syncUrl(S.url, newId()), { method: 'POST', headers: { authorization: 'Bearer k', 'content-type': 'application/json' }, body: '{}' });
    assert.equal(post405.status, 405); assert.equal(post405.headers.get('allow'), 'GET, HEAD, PUT, DELETE');
    assert.equal((await fetch(`${S.url}api/sync`, { headers: { authorization: 'Bearer k' } })).status, 404);
    assert.equal((await fetch(`${S.url}api/sync/`, { headers: { authorization: 'Bearer k' } })).status, 404);
    assert.equal((await fetch(`${S.url}api/sync/${newId()}/x`, { headers: { authorization: 'Bearer k' } })).status, 404);
  });

  test('sync 한도: JASO_SYNC_MAX_BYTES → 413, JASO_SYNC_MAX_ITEMS=1 → 507 sync_full, 별도 속도 제한, 재시작 후 유지, 로그에 id·본문 없음', async () => {
    const dataDir = path.join(tmpRoot, 'sync-limits');
    const srv = await startServer({ JASO_SYNC_MAX_BYTES: '100', JASO_SYNC_MAX_ITEMS: '1', JASO_SYNC_RATE_LIMIT: '6/600', JASO_DATA_DIR: dataDir, JASO_LOG_LEVEL: 'info' });
    assert.deepEqual((await health(srv.url)).sync, { enabled: true, items: 0, maxBytes: 100 });
    const id = newId();
    const big = await syncPut(srv.url, id, { payload: 'A'.repeat(101), updatedAt: 1 });
    assert.equal(big.status, 413); assert.equal((await big.json()).code, 'prompt_too_large');
    const SECRET_PAYLOAD = `${'Q'.repeat(60)}SECRETPAYLOAD`;
    assert.equal((await syncPut(srv.url, id, { payload: SECRET_PAYLOAD, updatedAt: 1 })).status, 200);
    const full = await syncPut(srv.url, newId(), { payload: 'BBBB', updatedAt: 1 });
    assert.equal(full.status, 507); assert.deepEqual(await full.json(), { code: 'sync_full', message: ERROR_TEXT.sync_full });
    assert.equal((await syncPut(srv.url, id, { payload: 'CCCC', updatedAt: 2 })).status, 200, '기존 id 갱신은 가득 차도 된다');
    assert.equal((await health(srv.url)).sync.items, 1);
    // 저장 파일: 서버는 payload 를 그대로(암호문) 보관한다
    const stored = JSON.parse(fs.readFileSync(path.join(dataDir, `${id}.json`), 'utf8'));
    assert.deepEqual(Object.keys(stored).sort(), ['bytes', 'etag', 'id', 'payload', 'storedAt', 'updatedAt']);
    assert.equal(stored.payload, 'CCCC'); assert.equal(stored.bytes, 4); assert.ok(stored.storedAt > 0);
    assert.equal(fs.statSync(dataDir).mode & 0o777, 0o700);
    // 속도 제한 6/600: 지금까지 4번 → 두 번 더 통과하고 일곱 번째는 429. /api/sample 은 별도 제한기라 영향 없음
    assert.equal((await syncGet(srv.url, id)).status, 200);
    assert.equal((await syncGet(srv.url, id)).status, 200);
    const limited = await syncGet(srv.url, id);
    assert.equal(limited.status, 429);
    const lj = await limited.json();
    assert.equal(lj.code, 'rate_limited'); assert.equal(limited.headers.get('retry-after'), String(lj.retryAfterSec));
    assert.equal((await post(srv.url, { input: PROMPT })).status, 200, 'sample 제한기는 따로');
    await srv.stop();
    const err = srv.stderr();
    assert.match(err, /PUT \/api\/sync\/:id 200/); assert.match(err, /PUT \/api\/sync\/:id 507 .*code=sync_full/); assert.match(err, /GET \/api\/sync\/:id 429/);
    assert.ok(!err.includes(id), '로그에 id 없음'); assert.ok(!err.includes('SECRETPAYLOAD'), '로그에 본문 없음');
    // 재시작해도 레코드는 남는다
    const again = await startServer({ JASO_DATA_DIR: dataDir });
    assert.equal((await health(again.url)).sync.items, 1);
    const g = await syncGet(again.url, id);
    assert.equal(g.status, 200); assert.equal((await g.json()).payload, 'CCCC');
    await again.stop();
  });

  test('JASO_SYNC=0: /api/sync 는 404, health.sync.enabled false', async () => {
    const srv = await startServer({ JASO_SYNC: '0' });
    assert.deepEqual((await health(srv.url)).sync, { enabled: false, items: 0, maxBytes: 2097152 });
    const id = newId();
    assert.equal((await syncGet(srv.url, id)).status, 404);
    assert.equal((await syncPut(srv.url, id, { payload: 'AQID', updatedAt: 1 })).status, 404);
    assert.equal((await syncGet(srv.url, id, { method: 'DELETE' })).status, 404);
    assert.equal((await post(srv.url, { input: PROMPT })).status, 200, 'sample 은 그대로');
    await srv.stop();
  });

  test('JASO_ALLOW_ANON=1 이면 sync 도 키 없이 쓸 수 있다', async () => {
    const srv = await startServer({ JASO_ACCESS_KEY: '', JASO_ALLOW_ANON: '1' });
    const id = newId();
    assert.equal((await syncPut(srv.url, id, { payload: 'AQID', updatedAt: 1 }, { key: '' })).status, 200);
    assert.equal((await syncGet(srv.url, id, { key: '' })).status, 200);
    await srv.stop();
  });

  test('SIGTERM 으로 깨끗하게 종료한다 (코드 0)', async () => {
    const srv = await startServer({});
    assert.equal((await health(srv.url)).service, 'jaso');
    const code = await srv.stop();
    assert.equal(code, 0);
  });
});
