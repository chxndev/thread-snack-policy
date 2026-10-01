import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRemoteSample, createSseParser, NETWORK_ERROR_TEXT } from '../jaso/src/llm-remote.js';
import { createSampleProvider, SAMPLE_ERROR_TEXT } from '../jaso/src/llm-sample.js';
import { INTERVIEW_REPLY_SCHEMA, JD_SCHEMA } from '../jaso/src/prompts.js';
import { createAgent } from '../jaso/src/agent.js';
import { sampleProject } from './helpers/fake-client.js';

const BASE = 'http://jaso.test/api/';
const enc = new TextEncoder();

const jsonResponse = (obj, status = 200) => new Response(JSON.stringify(obj), { status, headers: { 'content-type': 'application/json; charset=utf-8' } });
const textResponse = (text, status = 200) => new Response(text, { status, headers: { 'content-type': 'text/plain' } });

/** SSE 본문을 바이트로 만들고 주어진 바이트 위치들에서 잘라 내보내는 스트리밍 Response */
function sseResponse(sseText, cuts = [], { close = true } = {}) {
  const bytes = enc.encode(sseText);
  const parts = [];
  let prev = 0;
  for (const c of [...cuts, bytes.length]) { parts.push(bytes.slice(prev, c)); prev = c; }
  const stream = new ReadableStream({
    start(controller) {
      for (const p of parts) if (p.length) controller.enqueue(p);
      if (close) controller.close();
    },
  });
  return new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

const sse = (events) => events.map(([ev, data]) => `event: ${ev}\ndata: ${JSON.stringify(data)}\n\n`).join('');
const DONE = { text: '안녕하세요', truncated: false, modelTierApplied: 'default', model: 'claude-sonnet-x', data: null, usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }, costUsd: 0.001 };

/** 가짜 fetch: handler(req, index) → Response. req = { url, method, headers, body(JSON 해석), signal } */
function fakeFetch(handler) {
  const calls = [];
  const f = async (url, init = {}) => {
    const req = { url: String(url), method: init.method ?? 'GET', headers: init.headers ?? {}, body: init.body ? JSON.parse(init.body) : null, signal: init.signal };
    calls.push(req);
    return handler(req, calls.length - 1);
  };
  f.calls = calls;
  return f;
}

test('비스트리밍 호출: POST sample 본문·헤더와 결과 모양', async () => {
  const fetchImpl = fakeFetch(() => jsonResponse(DONE));
  const remote = createRemoteSample({ apiBase: BASE, getKey: () => 'k1', fetchImpl });
  const r = await remote('질문', { modelTier: 'complex', cache: false });
  assert.deepEqual(r, { text: '안녕하세요', truncated: false, modelTierApplied: 'default', model: 'claude-sonnet-x', usage: DONE.usage, costUsd: 0.001 });
  const c = fetchImpl.calls[0];
  assert.equal(c.url, `${BASE}sample`);
  assert.equal(c.method, 'POST');
  assert.deepEqual(c.body, { input: '질문', modelTier: 'complex', stream: true });
  assert.equal(c.headers.Authorization, 'Bearer k1');
  assert.equal(c.headers.Accept, 'text/event-stream', 'onText 가 없어도 항상 스트리밍을 요청한다');
  assert.equal(remote.acceptsSchema, true);
});

test('접속 키가 비어 있으면 Authorization 헤더를 보내지 않고, 등급 기본값은 default', async () => {
  const fetchImpl = fakeFetch(() => jsonResponse(DONE));
  const remote = createRemoteSample({ apiBase: BASE, fetchImpl });
  await remote('질문', {});
  assert.ok(!('Authorization' in fetchImpl.calls[0].headers));
  assert.equal(fetchImpl.calls[0].body.modelTier, 'default');
});

test('스트리밍: 줄·멀티바이트 문자 중간에서 잘린 SSE도 onText 순서와 최종 텍스트가 맞는다', async () => {
  const body = ': ping\n\n' + sse([['queued', { position: 1 }], ['delta', { text: '안녕', delta: '안녕' }], ['delta', { text: '안녕하세요', delta: '하세요' }], ['done', DONE]]);
  const bytes = enc.encode(body);
  const midLine = body.indexOf('event: delta') + 4; // 앞부분은 ASCII라 문자 index == 바이트 index
  const firstHangul = enc.encode(body.slice(0, body.indexOf('안'))).length + 1; // '안'(3바이트) 한가운데
  assert.ok(midLine < firstHangul && firstHangul + 40 < bytes.length);
  const fetchImpl = fakeFetch(() => sseResponse(body, [midLine, firstHangul, firstHangul + 40]));
  const remote = createRemoteSample({ apiBase: BASE, getKey: () => 'k', fetchImpl });
  const seen = [];
  const queued = [];
  const r = await remote('q', { onText: (e) => seen.push(e), onQueued: (q) => queued.push(q) });
  assert.deepEqual(seen, [{ text: '안녕', delta: '안녕' }, { text: '안녕하세요', delta: '하세요' }]);
  assert.deepEqual(queued, [{ position: 1 }]);
  assert.equal(r.text, '안녕하세요');
  assert.equal(r.model, 'claude-sonnet-x');
  assert.equal(r.costUsd, 0.001);
  assert.equal(fetchImpl.calls[0].body.stream, true);
  assert.equal(fetchImpl.calls[0].headers.Accept, 'text/event-stream');
});

test('스트리밍을 요청했는데 서버가 JSON으로 한 번에 답하면 onText를 한 번 부르고 결과를 돌려준다', async () => {
  const remote = createRemoteSample({ apiBase: BASE, fetchImpl: fakeFetch(() => jsonResponse(DONE)) });
  const seen = [];
  const r = await remote('q', { onText: (e) => seen.push(e) });
  assert.deepEqual(seen, [{ text: '안녕하세요', delta: '안녕하세요' }]);
  assert.equal(r.text, '안녕하세요');
});

test('스트리밍 중 error 이벤트는 코드·메시지·resetsAt·부분 텍스트를 가진 오류로 거절된다', async () => {
  const body = sse([['delta', { text: '부분', delta: '부분' }], ['error', { code: 'usage_limit', message: '운영자 Claude 구독의 사용량 한도에 걸렸습니다. 오후 3:00 이후 다시 시도해 주세요.', resetsAt: 1700000000 }]]);
  const remote = createRemoteSample({ apiBase: BASE, fetchImpl: fakeFetch(() => sseResponse(body)) });
  await assert.rejects(() => remote('q', { onText: () => {} }), (e) => e.code === 'usage_limit' && /오후 3:00/.test(e.message) && e.resetsAt === 1700000000 && e.text === '부분');
  // done도 error도 없이 끊기면 upstream_error
  const cut = createRemoteSample({ apiBase: BASE, fetchImpl: fakeFetch(() => sseResponse(sse([['delta', { text: '부분', delta: '부분' }]]))) });
  await assert.rejects(() => cut('q', { onText: () => {} }), (e) => e.code === 'upstream_error' && e.text === '부분');
});

test('HTTP 오류: 401 JSON → unauthorized, JSON이 아닌 404 → upstream_error(status 포함), 503 busy', async () => {
  const r1 = createRemoteSample({ apiBase: BASE, fetchImpl: fakeFetch(() => jsonResponse({ code: 'unauthorized', message: '접속 키가 올바르지 않습니다.' }, 401)) });
  await assert.rejects(() => r1('q', {}), (e) => e.code === 'unauthorized' && e.status === 401 && e.message === '접속 키가 올바르지 않습니다.');
  const r2 = createRemoteSample({ apiBase: BASE, fetchImpl: fakeFetch(() => textResponse('not found', 404)) });
  await assert.rejects(() => r2('q', {}), (e) => e.code === 'upstream_error' && e.status === 404 && e.message === SAMPLE_ERROR_TEXT.upstream_error);
  const r3 = createRemoteSample({ apiBase: BASE, fetchImpl: fakeFetch(() => jsonResponse({ code: 'busy', message: '지금 다른 요청을 처리하고 있습니다. 잠시 후 다시 시도해 주세요.' }, 503)) });
  await assert.rejects(() => r3('q', {}), (e) => e.code === 'busy' && e.status === 503);
  // JSON 본문에 code가 없으면 상태 코드로 추정하고 기본 문구를 쓴다
  const r4 = createRemoteSample({ apiBase: BASE, fetchImpl: fakeFetch(() => textResponse('{}', 429)) });
  await assert.rejects(() => r4('q', {}), (e) => e.code === 'rate_limited' && e.message === SAMPLE_ERROR_TEXT.rate_limited);
});

test('중단: signal이 울리면 부분 텍스트를 담은 cancelled로 거절되고, 이미 중단된 signal은 요청 없이 거절된다', async () => {
  const open = sse([['delta', { text: '부분', delta: '부분' }]]); // 닫히지 않는 스트림
  const fetchImpl = fakeFetch(() => sseResponse(open, [], { close: false }));
  const remote = createRemoteSample({ apiBase: BASE, fetchImpl });
  const ctl = new AbortController();
  const p = remote('q', { signal: ctl.signal, onText: () => queueMicrotask(() => ctl.abort()) });
  await assert.rejects(p, (e) => e.code === 'cancelled' && e.text === '부분');
  const ctl2 = new AbortController();
  ctl2.abort();
  await assert.rejects(() => remote('q', { signal: ctl2.signal }), (e) => e.code === 'cancelled');
  assert.equal(fetchImpl.calls.length, 1, '이미 중단된 요청은 fetch하지 않음');
  // fetch 자체가 AbortError로 실패하는 경우(브라우저)
  const ctl3 = new AbortController();
  const f3 = fakeFetch(() => { ctl3.abort(); const e = new Error('aborted'); e.name = 'AbortError'; throw e; });
  await assert.rejects(() => createRemoteSample({ apiBase: BASE, fetchImpl: f3 })('q', { signal: ctl3.signal }), (e) => e.code === 'cancelled');
});

test('네트워크 실패는 network 코드와 한국어 안내문', async () => {
  const remote = createRemoteSample({ apiBase: BASE, fetchImpl: fakeFetch(() => { throw new TypeError('fetch failed'); }) });
  await assert.rejects(() => remote('q', {}), (e) => e.code === 'network' && e.message === NETWORK_ERROR_TEXT);
  await assert.rejects(() => remote.health(), (e) => e.code === 'network');
});

test('json(): data가 있으면 그대로, 없으면 텍스트를 JSON으로 해석하고, 실패하면 invalid_json; schema는 주어졌을 때만 전송', async () => {
  const answers = [
    jsonResponse({ ...DONE, text: '', data: { a: 1 } }),
    jsonResponse({ ...DONE, text: '```json\n{"b":2}\n```', data: null }),
    jsonResponse({ ...DONE, text: '이건 JSON이 아닙니다', data: null }),
  ];
  const fetchImpl = fakeFetch((req, i) => answers[i]);
  const remote = createRemoteSample({ apiBase: BASE, fetchImpl });
  const schema = { type: 'object', properties: { a: { type: 'number' } } };
  assert.deepEqual(await remote.json('q', { schema }), { a: 1 });
  assert.deepEqual(fetchImpl.calls[0].body.schema, schema);
  assert.equal(fetchImpl.calls[0].body.stream, true);
  assert.deepEqual(await remote.json('q', {}), { b: 2 });
  assert.ok(!('schema' in fetchImpl.calls[1].body));
  await assert.rejects(() => remote.json('q', {}), (e) => e.code === 'invalid_json' && e.text === '이건 JSON이 아닙니다');
});

test('json() 스트리밍: onText로 조각을 받고 done의 data를 돌려준다 (인터뷰 질문 미리보기용)', async () => {
  const body = sse([['delta', { text: '{"q":', delta: '{"q":' }], ['delta', { text: '{"q":"안녕"}', delta: '"안녕"}' }], ['done', { ...DONE, text: '{"q":"안녕"}', data: { q: '안녕' } }]]);
  const fetchImpl = fakeFetch(() => sseResponse(body, [7]));
  const remote = createRemoteSample({ apiBase: BASE, fetchImpl });
  const seen = [];
  const out = await remote.json([{ role: 'user', content: 'hi' }], { schema: { type: 'object' }, onText: ({ text }) => seen.push(text) });
  assert.deepEqual(out, { q: '안녕' });
  assert.deepEqual(seen, ['{"q":', '{"q":"안녕"}']);
  assert.deepEqual(fetchImpl.calls[0].body.input, [{ role: 'user', content: 'hi' }]);
  assert.equal(fetchImpl.calls[0].body.stream, true);
});

test('limits()는 health의 limits.maxPromptBytes를 캐시하고, 실패하면 300000; health()는 JSON을 그대로 준다', async () => {
  const health = { service: 'jaso', runtime: 'server', version: '1', auth: 'key', login: { ok: true, method: 'claude.ai', checkedAt: 1, detail: '' }, queue: { active: 0, waiting: 0, concurrency: 1, maxQueue: 6 }, usageWindow: null, limits: { maxPromptBytes: 12345 }, tiers: {} };
  const fetchImpl = fakeFetch(() => jsonResponse(health));
  const remote = createRemoteSample({ apiBase: BASE, fetchImpl });
  assert.deepEqual(await remote.health(), health);
  assert.equal(fetchImpl.calls[0].url, `${BASE}health`);
  assert.equal(fetchImpl.calls[0].method, 'GET');
  assert.deepEqual(await remote.limits(), { maxPromptBytes: 12345 });
  assert.deepEqual(await remote.limits(), { maxPromptBytes: 12345 });
  assert.equal(fetchImpl.calls.length, 2, 'limits는 캐시됨');
  const broken = createRemoteSample({ apiBase: BASE, fetchImpl: fakeFetch(() => textResponse('nope', 500)) });
  assert.deepEqual(await broken.limits(), { maxPromptBytes: 300000 });
  await assert.rejects(() => broken.health(), (e) => e.status === 500);
});

test('SSE 파서: CRLF·주석·여러 data 줄·마지막 빈 줄 누락을 처리한다', () => {
  const events = [];
  const p = createSseParser((e) => events.push(e));
  p.feed('event: a\r\ndata: 1\r\ndata: 2\r\n\r\n: comment\n');
  p.feed('data: {"x":');
  p.feed('1}\n\nevent: b\ndata: last');
  p.end();
  assert.deepEqual(events, [{ event: 'a', data: '1\n2' }, { event: 'message', data: '{"x":1}' }, { event: 'b', data: 'last' }]);
});

test('createSampleProvider: acceptsSchema인 sample에는 json·인터뷰 호출에 schema를 넘기고, 아니면 넘기지 않는다', async () => {
  const calls = [];
  const sample = async () => ({ text: 'x', truncated: false, modelTierApplied: 'default' });
  sample.json = async (input, opts) => { calls.push(opts); return Array.isArray(input) ? { saved: [], question: null, finish: { summary: 's', writer_notes: '' } } : { ok: true }; };
  sample.acceptsSchema = true;
  const provider = createSampleProvider({ sample, cfg: { tier: 'complex' } });
  const schema = { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'], additionalProperties: false };
  assert.deepEqual(await provider.json({ system: 's', user: 'u', schema }), { ok: true });
  assert.deepEqual(calls[0].schema, schema);
  assert.equal(calls[0].modelTier, 'default');
  const project = sampleProject();
  project.interview = { ...project.interview, status: 'running', messages: provider.openInterview(project) };
  const res = await provider.interviewStep(project, {});
  assert.equal(res.type, 'done');
  assert.deepEqual(calls[1].schema, INTERVIEW_REPLY_SCHEMA);
  // acceptsSchema가 없는 아티팩트 sample에는 schema를 넘기지 않는다
  const plainCalls = [];
  const plain = async () => ({ text: 'x' });
  plain.json = async (input, opts) => { plainCalls.push(opts); return { ok: true }; };
  await createSampleProvider({ sample: plain, cfg: {} }).json({ system: 's', user: 'u', schema });
  assert.ok(!('schema' in plainCalls[0]));
});

test('제공자를 거친 서버 오류는 AgentError(code)가 되고, 서버의 한국어 문구와 resetsAt을 우선한다', async () => {
  const fetchImpl = fakeFetch(() => jsonResponse({ code: 'usage_limit', message: '운영자 Claude 구독의 사용량 한도에 걸렸습니다. 오후 3:00 이후 다시 시도해 주세요.', resetsAt: 1 }, 429));
  const provider = createSampleProvider({ sample: createRemoteSample({ apiBase: BASE, fetchImpl }), cfg: {} });
  await assert.rejects(() => provider.text({ system: 's', user: 'u' }), (e) => e.name === 'AgentError' && e.code === 'usage_limit' && /오후 3:00/.test(e.message) && e.resetsAt === 1 && e.status === 429);
  const f2 = fakeFetch(() => jsonResponse({ code: 'unauthorized' }, 401)); // 문구가 없으면 기본 문구
  await assert.rejects(() => createSampleProvider({ sample: createRemoteSample({ apiBase: BASE, fetchImpl: f2 }), cfg: {} }).text({ system: 's', user: 'u' }), (e) => e.code === 'unauthorized' && e.message === SAMPLE_ERROR_TEXT.unauthorized);
  const f3 = fakeFetch(() => { throw new TypeError('fetch failed'); });
  await assert.rejects(() => createSampleProvider({ sample: createRemoteSample({ apiBase: BASE, fetchImpl: f3 }), cfg: {} }).text({ system: 's', user: 'u' }), (e) => e.code === 'network' && e.message === SAMPLE_ERROR_TEXT.network);
});

test('전체 연결: createAgent + createSampleProvider + createRemoteSample — 공고 분석은 schema와 함께 전송되고 data를 돌려준다', async () => {
  const jd = { company: '네이버', role: '백엔드 개발', level: 'new', questions: [], competencies: ['Java'], talent: '', notes: '' };
  const fetchImpl = fakeFetch(() => jsonResponse({ ...DONE, text: '', data: jd }));
  const remote = createRemoteSample({ apiBase: BASE, getKey: () => 'k', fetchImpl });
  const usage = [];
  const agent = createAgent({ provider: createSampleProvider({ sample: remote, cfg: { tier: 'complex' }, onUsage: (u) => usage.push(u) }), settings: { tier: 'complex' } });
  const res = await agent.analyzeJobPosting('공고 본문');
  assert.equal(res.company, '네이버');
  const body = fetchImpl.calls[0].body;
  assert.deepEqual(body.schema, JD_SCHEMA);
  assert.equal(body.modelTier, 'default');
  assert.match(body.input, /채용 분석가/);
  assert.equal(fetchImpl.calls[0].headers.Authorization, 'Bearer k');
  assert.equal(usage.length, 1);
  assert.equal(usage[0].model, 'claude.ai/default');
});
