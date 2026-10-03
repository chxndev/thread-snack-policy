import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SYNC_ALPHABET, SYNC_ERROR_TEXT, generateSyncCode, normalizeSyncCode, deriveSync, encryptJson, decryptJson, toBase64Url, fromBase64Url, createSyncClient } from '../jaso/src/sync.js';
import { SAMPLE_ERROR_TEXT } from '../jaso/src/llm-sample.js';

const BASE = 'http://jaso.test/api/';
const CODE = 'jaso-abcd-efgh-jkmn-pqrs';
const ID_RE = /^[a-f0-9]{32}$/;

const jsonResponse = (obj, status = 200, headers = {}) => new Response(obj === null ? null : JSON.stringify(obj), { status, headers: { 'content-type': 'application/json; charset=utf-8', ...headers } });

/** 가짜 fetch: handler(req, index) → Response. req = { url, method, headers, body(JSON 해석) } */
function fakeFetch(handler) {
  const calls = [];
  const f = async (url, init = {}) => {
    const req = { url: String(url), method: init.method ?? 'GET', headers: init.headers ?? {}, body: init.body ? JSON.parse(init.body) : null };
    calls.push(req);
    return handler(req, calls.length - 1);
  };
  f.calls = calls;
  return f;
}

// ───────────── 코드 ─────────────

test('generateSyncCode: jaso-xxxx-xxxx-xxxx-xxxx 형식, 알파벳 안의 기호만, 매번 다르다', () => {
  const seen = new Set();
  for (let i = 0; i < 200; i++) {
    const code = generateSyncCode();
    assert.match(code, /^jaso(-[a-z2-9]{4}){4}$/, code);
    const symbols = code.slice(5).replace(/-/g, '');
    assert.equal(symbols.length, 16);
    for (const c of symbols) assert.ok(SYNC_ALPHABET.includes(c), `알파벳 밖 기호 ${c}`);
    seen.add(code);
  }
  assert.equal(seen.size, 200, '200개가 모두 달라야 한다');
  assert.equal(SYNC_ALPHABET.length, 31);
  for (const c of '01iloILO') assert.ok(!SYNC_ALPHABET.includes(c), `헷갈리는 글자 ${c} 는 빠져야 한다`);
});

test('generateSyncCode: 모든 기호가 고르게 나온다(편향 없는 추출)', () => {
  const counts = Object.fromEntries([...SYNC_ALPHABET].map((c) => [c, 0]));
  for (let i = 0; i < 400; i++) for (const c of generateSyncCode().slice(5).replace(/-/g, '')) counts[c]++;
  const values = Object.values(counts);
  assert.ok(values.every((n) => n > 0), '한 번도 안 나온 기호가 있음');
  assert.ok(Math.max(...values) < Math.min(...values) * 3, `분포가 치우침: ${JSON.stringify(counts)}`);
});

test('normalizeSyncCode: 대소문자·공백·대시·접두사를 정리하고, 잘못된 입력은 null', () => {
  assert.equal(normalizeSyncCode(CODE), CODE);
  assert.equal(normalizeSyncCode('  JASO-ABCD-EFGH-JKMN-PQRS  '), CODE);
  assert.equal(normalizeSyncCode('abcdefghjkmnpqrs'), CODE, '접두사·대시 없이 16기호');
  assert.equal(normalizeSyncCode('abcd efgh jkmn pqrs'), CODE, '공백 구분');
  assert.equal(normalizeSyncCode('jaso abcd-efgh_jkmn.pqrs'), CODE, '여러 구분자');
  assert.equal(normalizeSyncCode('jasoabcdefghjkmnpqrs'), CODE, '붙여 쓴 접두사');
  assert.equal(normalizeSyncCode(''), null);
  assert.equal(normalizeSyncCode('jaso-abcd-efgh-jkmn'), null, '12기호');
  assert.equal(normalizeSyncCode('jaso-abcd-efgh-jkmn-pqrs-tuvw'), null, '20기호');
  assert.equal(normalizeSyncCode('jaso-abcd-efgh-jkmn-pqr0'), null, '0 은 알파벳 밖');
  assert.equal(normalizeSyncCode('jaso-abcd-efgh-jkmn-pqrl'), null, 'l 은 알파벳 밖');
  assert.equal(normalizeSyncCode('jaso-abcd-efgh-jkmn-pq가s'), null);
  assert.equal(normalizeSyncCode(null), null);
  assert.equal(normalizeSyncCode(12345), null);
  assert.equal(normalizeSyncCode(generateSyncCode().toUpperCase()).length, CODE.length);
});

// ───────────── 키 파생·암호화 ─────────────

test('deriveSync: 같은 코드(표기 달라도) → 같은 id·키, 다른 코드 → 다른 id; id 는 32자 hex', async () => {
  const a = await deriveSync(CODE);
  const b = await deriveSync('ABCD EFGH JKMN PQRS');
  const c = await deriveSync('jaso-abcd-efgh-jkmn-pqrt');
  assert.match(a.id, ID_RE);
  assert.equal(a.id, b.id, '정규형이 같으면 id 도 같다');
  assert.notEqual(a.id, c.id);
  assert.equal(a.key.type, 'secret');
  assert.equal(a.key.algorithm.name, 'AES-GCM');
  assert.equal(a.key.algorithm.length, 256);
  assert.equal(a.key.extractable, false);
  // a 의 키로 잠근 것을 b 의 키로 열 수 있어야 같은 키다
  const payload = await encryptJson(a.key, { x: 1 });
  assert.deepEqual(await decryptJson(b.key, payload), { x: 1 });
  // id 는 SHA-256('jaso-sync-id:' + 정규형) 앞 16바이트
  const digest = new Uint8Array(await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(`jaso-sync-id:${CODE}`)));
  assert.equal(a.id, [...digest.slice(0, 16)].map((x) => x.toString(16).padStart(2, '0')).join(''));
});

test('deriveSync: 잘못된 코드는 sync_badcode', async () => {
  await assert.rejects(deriveSync('nope'), (e) => e.code === 'sync_badcode' && e.message === SYNC_ERROR_TEXT.sync_badcode);
});

test('encryptJson/decryptJson: 왕복, 버전 바이트·IV 구조, 매번 다른 암호문', async () => {
  const { key } = await deriveSync(CODE);
  const obj = { project: { profile: { company: '네이버' }, questions: [{ id: 'q1', text: '지원 동기' }] }, updatedAt: 1700000000000 };
  const p1 = await encryptJson(key, obj);
  const p2 = await encryptJson(key, obj);
  assert.match(p1, /^[A-Za-z0-9_-]+$/, 'base64url');
  assert.notEqual(p1, p2, 'IV 가 매번 달라야 한다');
  const bytes = fromBase64Url(p1);
  assert.equal(bytes[0], 1, '버전 바이트');
  assert.ok(bytes.length >= 1 + 12 + 16, 'IV 12 + GCM 태그 16');
  assert.deepEqual(await decryptJson(key, p1), obj);
  assert.deepEqual(await decryptJson(key, p2), obj);
});

test('decryptJson: 변조 → 던짐(sync_badkey), 다른 코드의 키 → sync_badkey, 깨진 형식 → sync_corrupt, 모르는 버전 → sync_version', async () => {
  const { key } = await deriveSync(CODE);
  const other = await deriveSync('jaso-abcd-efgh-jkmn-pqrt');
  const payload = await encryptJson(key, { secret: '비밀' });
  await assert.rejects(decryptJson(other.key, payload), (e) => e.code === 'sync_badkey' && e.message === SYNC_ERROR_TEXT.sync_badkey);
  // 암호문 마지막 바이트를 바꾼다
  const bytes = fromBase64Url(payload);
  bytes[bytes.length - 1] ^= 0x01;
  await assert.rejects(decryptJson(key, toBase64Url(bytes)), (e) => e.code === 'sync_badkey');
  // IV 를 바꿔도 실패
  const bytes2 = fromBase64Url(payload);
  bytes2[3] ^= 0xff;
  await assert.rejects(decryptJson(key, toBase64Url(bytes2)), (e) => e.code === 'sync_badkey');
  await assert.rejects(decryptJson(key, 'not base64url!'), (e) => e.code === 'sync_corrupt');
  await assert.rejects(decryptJson(key, 'AQID'), (e) => e.code === 'sync_corrupt', '너무 짧음');
  const v2 = fromBase64Url(payload);
  v2[0] = 2;
  await assert.rejects(decryptJson(key, toBase64Url(v2)), (e) => e.code === 'sync_version');
  const v0 = fromBase64Url(payload);
  v0[0] = 0;
  await assert.rejects(decryptJson(key, toBase64Url(v0)), (e) => e.code === 'sync_corrupt');
});

test('base64url 왕복: 패딩 없음, 2^15 넘는 길이도 처리', () => {
  const big = new Uint8Array(70000);
  for (let i = 0; i < big.length; i++) big[i] = (i * 7) & 0xff;
  const s = toBase64Url(big);
  assert.ok(!/[+/=]/.test(s));
  assert.deepEqual(fromBase64Url(s), big);
  assert.equal(fromBase64Url('a+b'), null);
  assert.equal(fromBase64Url(''), null);
});

// ───────────── 서버 클라이언트 ─────────────

const ID = 'a'.repeat(32);
const REC = { id: ID, etag: 'e1'.padEnd(32, '0'), updatedAt: 1700000000000, payload: 'AQIDBA' };

test('get: 200 → ok (본문 etag 우선), 접속 키 → Authorization, If-None-Match 는 etag 를 줄 때만', async () => {
  const fetchImpl = fakeFetch(() => jsonResponse(REC, 200, { etag: `"${REC.etag}"` }));
  const client = createSyncClient({ apiBase: BASE, getKey: () => 'k1', fetchImpl });
  const r = await client.get(ID);
  assert.deepEqual(r, { status: 'ok', etag: REC.etag, updatedAt: REC.updatedAt, payload: REC.payload });
  const c = fetchImpl.calls[0];
  assert.equal(c.url, `${BASE}sync/${ID}`);
  assert.equal(c.method, 'GET');
  assert.equal(c.headers.Authorization, 'Bearer k1');
  assert.ok(!('If-None-Match' in c.headers));
  await client.get(ID, { etag: 'abc' });
  assert.equal(fetchImpl.calls[1].headers['If-None-Match'], '"abc"');
});

test('get: etag 가 본문에 없으면 ETag 헤더(따옴표 제거)에서 가져온다; 접속 키가 없으면 Authorization 생략', async () => {
  const fetchImpl = fakeFetch(() => jsonResponse({ id: ID, updatedAt: 5, payload: 'AQ' }, 200, { etag: '"hdr-etag"' }));
  const client = createSyncClient({ apiBase: BASE, fetchImpl });
  const r = await client.get(ID);
  assert.equal(r.etag, 'hdr-etag');
  assert.ok(!('Authorization' in fetchImpl.calls[0].headers));
});

test('get: 304 → notmodified, 404 → missing', async () => {
  const fetchImpl = fakeFetch((req, i) => (i === 0 ? new Response(null, { status: 304 }) : jsonResponse({ code: 'not_found', message: '없음' }, 404)));
  const client = createSyncClient({ apiBase: BASE, fetchImpl });
  assert.deepEqual(await client.get(ID, { etag: 'x' }), { status: 'notmodified' });
  assert.deepEqual(await client.get(ID), { status: 'missing' });
});

test('get: 401 → unauthorized(서버 문구), 429 → rate_limited + retryAfterSec, 네트워크 오류 → network', async () => {
  const fetchImpl = fakeFetch((req, i) => {
    if (i === 0) return jsonResponse({ code: 'unauthorized', message: '접속 키가 올바르지 않습니다.' }, 401);
    if (i === 1) return jsonResponse({ code: 'rate_limited', message: '요청이 너무 많습니다. 30초 후 다시 시도해 주세요.', retryAfterSec: 30 }, 429);
    throw new TypeError('Failed to fetch');
  });
  const client = createSyncClient({ apiBase: BASE, fetchImpl });
  await assert.rejects(client.get(ID), (e) => e.code === 'unauthorized' && e.status === 401 && e.message === '접속 키가 올바르지 않습니다.');
  await assert.rejects(client.get(ID), (e) => e.code === 'rate_limited' && e.retryAfterSec === 30 && /30초/.test(e.message));
  await assert.rejects(client.get(ID), (e) => e.code === 'network' && e.message === SAMPLE_ERROR_TEXT.network);
});

test('get/put/remove: id 형식이 아니면 요청 없이 invalid_request', async () => {
  const fetchImpl = fakeFetch(() => jsonResponse(REC));
  const client = createSyncClient({ apiBase: BASE, fetchImpl });
  await assert.rejects(client.get('short'), (e) => e.code === 'invalid_request');
  await assert.rejects(client.put('A'.repeat(32), { payload: 'AQ', updatedAt: 1 }), (e) => e.code === 'invalid_request', '대문자 hex 거부');
  await assert.rejects(client.remove('../x'), (e) => e.code === 'invalid_request');
  await assert.rejects(client.put(ID, { payload: 'not+base64url', updatedAt: 1 }), (e) => e.code === 'invalid_request', 'base64url 아닌 payload');
  assert.equal(fetchImpl.calls.length, 0);
});

test('put: 본문·헤더 모양, If-Match 는 ifMatch 를 줄 때만, 200 → ok', async () => {
  const fetchImpl = fakeFetch(() => jsonResponse({ id: ID, etag: 'new-etag', updatedAt: 1700000001000 }));
  const client = createSyncClient({ apiBase: BASE, getKey: () => 'k2', fetchImpl });
  const r = await client.put(ID, { payload: 'AQIDBA', updatedAt: 1700000001000 });
  assert.deepEqual(r, { status: 'ok', etag: 'new-etag', updatedAt: 1700000001000 });
  const c = fetchImpl.calls[0];
  assert.equal(c.method, 'PUT');
  assert.equal(c.url, `${BASE}sync/${ID}`);
  assert.equal(c.headers['Content-Type'], 'application/json');
  assert.equal(c.headers.Authorization, 'Bearer k2');
  assert.ok(!('If-Match' in c.headers), 'etag 를 모르면 If-Match 생략');
  assert.deepEqual(c.body, { payload: 'AQIDBA', updatedAt: 1700000001000 });
  await client.put(ID, { payload: 'AQIDBA', updatedAt: 2, ifMatch: 'old-etag' });
  assert.equal(fetchImpl.calls[1].headers['If-Match'], '"old-etag"');
});

test('put: 412 → conflict 에 서버의 etag·updatedAt·payload 가 실린다', async () => {
  const fetchImpl = fakeFetch(() => jsonResponse({ code: 'sync_conflict', etag: 'server-etag', updatedAt: 1700000002000, payload: 'BQYH' }, 412));
  const client = createSyncClient({ apiBase: BASE, fetchImpl });
  const r = await client.put(ID, { payload: 'AQ', updatedAt: 1, ifMatch: 'mine' });
  assert.deepEqual(r, { status: 'conflict', etag: 'server-etag', updatedAt: 1700000002000, payload: 'BQYH' });
});

test('put: 412 sync_missing(If-Match 인데 서버 사본 없음) → missing', async () => {
  const fetchImpl = fakeFetch(() => jsonResponse({ code: 'sync_missing', message: '서버에 이 코드의 동기화 사본이 없습니다(다른 기기에서 삭제했거나 오래되어 만료됨).' }, 412));
  const client = createSyncClient({ apiBase: BASE, fetchImpl });
  assert.deepEqual(await client.put(ID, { payload: 'AQ', updatedAt: 1, ifMatch: 'old' }), { status: 'missing' });
  assert.equal(fetchImpl.calls[0].headers['If-Match'], '"old"');
  assert.ok(SYNC_ERROR_TEXT.sync_missing.includes('삭제'));
});

test('put: 401 → unauthorized, 413 → sync_too_large(고유 문구), 507 → sync_full, JSON 없는 413 도 sync_too_large', async () => {
  const fetchImpl = fakeFetch((req, i) => {
    if (i === 0) return jsonResponse({ code: 'unauthorized', message: '접속 키가 올바르지 않습니다.' }, 401);
    if (i === 1) return jsonResponse({ code: 'prompt_too_large', message: '보내는 내용이 너무 깁니다. 경험 카드나 공고 내용을 줄여 주세요.' }, 413);
    if (i === 2) return jsonResponse({ code: 'sync_full', message: '서버의 동기화 저장 공간이 가득 찼습니다. 운영자에게 알려 주세요.' }, 507);
    return new Response('Payload Too Large', { status: 413, headers: { 'content-type': 'text/plain' } });
  });
  const client = createSyncClient({ apiBase: BASE, getKey: () => 'bad', fetchImpl });
  const args = { payload: 'AQ', updatedAt: 1 };
  await assert.rejects(client.put(ID, args), (e) => e.code === 'unauthorized' && e.status === 401);
  await assert.rejects(client.put(ID, args), (e) => e.code === 'sync_too_large' && e.message === SYNC_ERROR_TEXT.sync_too_large && e.status === 413);
  await assert.rejects(client.put(ID, args), (e) => e.code === 'sync_full' && e.message === SYNC_ERROR_TEXT.sync_full && e.status === 507);
  await assert.rejects(client.put(ID, args), (e) => e.code === 'sync_too_large' && e.status === 413);
});

test('remove: DELETE → 204 와 404 모두 true, 401 은 던짐', async () => {
  const fetchImpl = fakeFetch((req, i) => (i === 0 ? new Response(null, { status: 204 }) : i === 1 ? jsonResponse({ code: 'not_found' }, 404) : jsonResponse({ code: 'unauthorized', message: '접속 키가 올바르지 않습니다.' }, 401)));
  const client = createSyncClient({ apiBase: BASE, getKey: () => 'k', fetchImpl });
  assert.equal(await client.remove(ID), true);
  assert.equal(fetchImpl.calls[0].method, 'DELETE');
  assert.equal(fetchImpl.calls[0].headers.Authorization, 'Bearer k');
  assert.equal(await client.remove(ID), true);
  await assert.rejects(client.remove(ID), (e) => e.code === 'unauthorized');
});

test('종단 간: 한 기기가 암호화해 PUT 한 payload 를 다른 기기가 GET 해 같은 코드로 풀고, 서버는 평문을 모른다', async () => {
  const store = new Map();
  const fetchImpl = fakeFetch((req) => {
    const id = req.url.slice(req.url.lastIndexOf('/') + 1);
    if (req.method === 'PUT') { store.set(id, { etag: `e${store.size + 1}`, ...req.body }); return jsonResponse({ id, etag: store.get(id).etag, updatedAt: req.body.updatedAt }); }
    if (req.method === 'GET') { const rec = store.get(id); return rec ? jsonResponse({ id, ...rec }) : jsonResponse({ code: 'not_found' }, 404); }
    return new Response(null, { status: 204 });
  });
  const client = createSyncClient({ apiBase: BASE, fetchImpl });
  const code = generateSyncCode();
  const a = await deriveSync(code);
  const b = await deriveSync(code.toUpperCase().replace(/-/g, ' '));
  const project = { profile: { company: '네이버', role: '백엔드' }, questions: [{ id: 'q1', text: '지원 동기' }] };
  const payload = await encryptJson(a.key, { v: 1, project });
  assert.ok(!payload.includes('네이버') && !JSON.stringify([...store.values()]).includes('네이버'), '평문이 서버 자료에 없어야 한다');
  const put = await client.put(a.id, { payload, updatedAt: 123 });
  assert.equal(put.status, 'ok');
  const got = await client.get(b.id);
  assert.equal(got.status, 'ok');
  assert.equal(got.updatedAt, 123);
  assert.deepEqual(await decryptJson(b.key, got.payload), { v: 1, project });
  const wrong = await deriveSync(generateSyncCode());
  assert.deepEqual(await client.get(wrong.id), { status: 'missing' }, '다른 코드는 다른 id 라 기록이 없다');
});
