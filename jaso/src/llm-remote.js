// 운영자 구독 서버 제공자: 페이지와 같은 곳에서 서빙되는 jaso 서버(../api/)에 요청을 보내고,
// 서버가 운영자의 claude.ai 구독(Claude Code CLI 헤드리스)으로 Claude를 호출한다.
// createSampleProvider가 기대하는 아티팩트 sample 함수와 같은 모양(fn(input, opts), fn.json(input, opts))을 돌려준다.
// Node 단위 테스트에서도 불러올 수 있도록 location/fetch는 호출 시점에만 참조한다.
import { cleanModelText } from './text.js';
import { SAMPLE_ERROR_TEXT } from './llm-sample.js';

export const NETWORK_ERROR_TEXT = '서버에 연결할 수 없습니다. 운영자의 PC나 터널이 꺼져 있을 수 있습니다.';
const DEFAULT_MAX_PROMPT_BYTES = 300000;
/** 서버가 JSON 오류 본문을 주지 못했을 때(정적 서버의 404 등) HTTP 상태로 코드를 추정한다 */
const STATUS_CODES = { 400: 'invalid_request', 401: 'unauthorized', 413: 'prompt_too_large', 422: 'refused', 429: 'rate_limited', 503: 'busy', 504: 'timeout' };

const remoteError = (code, message, extra = {}) => ({ code, message, ...extra });
const copyIf = (target, src, keys) => { for (const k of keys) if (src?.[k] != null) target[k] = src[k]; return target; };

/**
 * SSE(text/event-stream) 파서. 청크 경계가 줄·이벤트 중간에 걸려도 동작하고, ':' 주석 줄은 무시한다.
 * @param {(ev: { event: string, data: string }) => void} onEvent  빈 줄마다 호출 (data 줄이 여럿이면 '\n'으로 합침)
 */
export function createSseParser(onEvent) {
  let buf = '';
  let event = '';
  let data = [];
  const dispatch = () => {
    if (data.length) onEvent({ event: event || 'message', data: data.join('\n') });
    event = '';
    data = [];
  };
  const line = (l) => {
    if (l === '') { dispatch(); return; }
    if (l.startsWith(':')) return;
    const i = l.indexOf(':');
    const field = i < 0 ? l : l.slice(0, i);
    const value = i < 0 ? '' : l.slice(i + 1).replace(/^ /, '');
    if (field === 'event') event = value;
    else if (field === 'data') data.push(value);
  };
  return {
    feed(chunk) {
      buf += chunk;
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        line(buf.slice(0, nl).replace(/\r$/, ''));
        buf = buf.slice(nl + 1);
      }
    },
    end() {
      if (buf) { line(buf.replace(/\r$/, '')); buf = ''; }
      dispatch();
    },
  };
}

/**
 * @param {object} [o]
 * @param {string} [o.apiBase]   서버 API 루트 (기본: 페이지 기준 ../api/). 끝에 '/'가 있어야 한다.
 * @param {() => string} [o.getKey]  접속 키를 돌려주는 함수 (비어 있으면 Authorization 헤더 생략)
 * @param {typeof fetch} [o.fetchImpl]  테스트용 fetch 대체
 */
export function createRemoteSample({ apiBase, getKey = () => '', fetchImpl } = {}) {
  const base = () => apiBase ?? new URL('../api/', location.href).href;
  const doFetch = (url, init) => (fetchImpl ?? globalThis.fetch)(url, init);
  let limitsCache = null;

  function headers(stream) {
    const h = { 'Content-Type': 'application/json', Accept: stream ? 'text/event-stream' : 'application/json' };
    const key = getKey() || '';
    if (key) h.Authorization = `Bearer ${key}`;
    return h;
  }

  /** !res.ok 응답을 오류 객체로: JSON 본문의 code/message를 그대로 쓰고, 없으면 상태 코드로 추정한다 */
  async function errorFromResponse(res) {
    let body = null;
    try { body = JSON.parse(await res.text()); } catch { /* JSON이 아닌 오류 본문 */ }
    const code = (typeof body?.code === 'string' && body.code) || STATUS_CODES[res.status] || 'upstream_error';
    const message = (typeof body?.message === 'string' && body.message) || SAMPLE_ERROR_TEXT[code] || `서버 오류 (HTTP ${res.status})`;
    return copyIf(remoteError(code, message, { status: res.status }), body, ['resetsAt', 'retryAfterSec', 'detail']);
  }

  /**
   * POST sample. 항상 SSE 스트리밍으로 요청한다: onText 가 없어도 대기열(queued)·핑이 계속 흘러야
   * 터널(Cloudflare 는 응답 헤더까지 100초)이 끊지 않는다. 서버가 JSON 으로 한 번에 답하면 그대로 받는다.
   * 서버의 결과 객체(done)를 그대로 돌려준다.
   */
  async function request(input, opts = {}, { schema } = {}) {
    const signal = opts.signal;
    const stream = true;
    const body = { input, modelTier: opts.modelTier ?? 'default', stream };
    if (schema) body.schema = schema;
    let text = '';
    const cancelled = () => remoteError('cancelled', 'cancelled', { text });
    if (signal?.aborted) throw cancelled();

    let res;
    try {
      res = await doFetch(`${base()}sample`, { method: 'POST', headers: headers(stream), body: JSON.stringify(body), signal });
    } catch (e) {
      if (signal?.aborted || e?.name === 'AbortError') throw cancelled();
      throw remoteError('network', NETWORK_ERROR_TEXT, { detail: e?.message ?? String(e) });
    }
    if (!res.ok) throw await errorFromResponse(res);

    const ctype = res.headers?.get?.('content-type') ?? '';
    if (!/text\/event-stream/i.test(ctype)) {
      // 스트리밍을 요청했더라도 서버가 한 번에 응답할 수 있다
      let json;
      try { json = await res.json(); } catch (e) {
        if (signal?.aborted) throw cancelled();
        throw remoteError('upstream_error', SAMPLE_ERROR_TEXT.upstream_error, { detail: `응답 본문이 JSON이 아닙니다: ${e?.message ?? e}` });
      }
      if (typeof opts.onText === 'function' && typeof json?.text === 'string' && json.text) opts.onText({ text: json.text, delta: json.text });
      return json;
    }

    // SSE: queued* → delta* → done | error
    let result = null;
    let failure = null;
    const parser = createSseParser(({ event, data }) => {
      let payload;
      try { payload = JSON.parse(data); } catch { return; }
      if (event === 'delta') {
        text = typeof payload.text === 'string' ? payload.text : text + (payload.delta ?? '');
        try { opts.onText?.({ text, delta: payload.delta ?? '' }); } catch (err) { console.error('onText handler error', err); }
      } else if (event === 'queued') {
        try { opts.onQueued?.(payload); } catch { /* 선택 핸들러 */ }
      } else if (event === 'done') {
        result = payload;
      } else if (event === 'error') {
        const code = (typeof payload.code === 'string' && payload.code) || 'upstream_error';
        failure = copyIf(remoteError(code, payload.message || SAMPLE_ERROR_TEXT[code] || SAMPLE_ERROR_TEXT.upstream_error, { status: res.status, text }), payload, ['resetsAt', 'retryAfterSec', 'detail']);
      }
    });

    if (!res.body?.getReader) {
      parser.feed(await res.text());
      parser.end();
    } else {
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let rejectAbort = null;
      // 가짜 Response처럼 signal이 본문 스트림을 끊어 주지 않는 환경에서도 중단이 먹도록 read()와 경쟁시킨다
      const abortPromise = signal ? new Promise((_, reject) => { rejectAbort = () => reject(cancelled()); signal.addEventListener('abort', rejectAbort, { once: true }); }) : null;
      abortPromise?.catch(() => {}); // 경쟁에 쓰이지 않고 끝나도 unhandled rejection이 되지 않게
      try {
        while (!result && !failure) {
          const step = abortPromise ? await Promise.race([reader.read(), abortPromise]) : await reader.read();
          if (step.done) { parser.feed(decoder.decode()); parser.end(); break; }
          parser.feed(typeof step.value === 'string' ? step.value : decoder.decode(step.value, { stream: true }));
        }
      } catch (e) {
        if (signal?.aborted || e?.code === 'cancelled' || e?.name === 'AbortError') throw cancelled();
        throw remoteError('network', NETWORK_ERROR_TEXT, { detail: e?.message ?? String(e), text });
      } finally {
        if (rejectAbort) signal.removeEventListener('abort', rejectAbort);
        reader.cancel().catch(() => {});
      }
    }
    if (failure) throw failure;
    if (!result) throw remoteError('upstream_error', '응답이 중간에 끊겼습니다. 다시 시도해 주세요.', { text });
    if (typeof result.text !== 'string') result.text = text;
    return result;
  }

  const pick = (r) => ({ text: typeof r.text === 'string' ? r.text : '', truncated: !!r.truncated, modelTierApplied: r.modelTierApplied ?? null, model: r.model ?? null, usage: r.usage ?? null, costUsd: r.costUsd ?? null });

  /** sample(input, opts) 호환 → { text, truncated, modelTierApplied, model, usage, costUsd } */
  async function fn(input, opts = {}) {
    return pick(await request(input, opts));
  }

  /** sample.json(input, opts) 호환: opts.schema가 있으면 서버에 넘겨 구조화 출력(data)을 받고, 없으면 텍스트를 JSON으로 해석한다 */
  fn.json = async function json(input, opts = {}) {
    const schema = opts.schema && typeof opts.schema === 'object' ? opts.schema : undefined;
    const r = await request(input, opts, { schema });
    if (r.data !== null && r.data !== undefined) return r.data;
    const text = typeof r.text === 'string' ? r.text : '';
    try { return JSON.parse(cleanModelText(text)); } catch { throw remoteError('invalid_json', SAMPLE_ERROR_TEXT.invalid_json, { text }); }
  };

  /** GET health → 서버 상태 JSON (네트워크 오류·비정상 응답은 throw) */
  fn.health = async function health() {
    let res;
    try { res = await doFetch(`${base()}health`, { method: 'GET', headers: { Accept: 'application/json' } }); }
    catch (e) { throw remoteError('network', NETWORK_ERROR_TEXT, { detail: e?.message ?? String(e) }); }
    if (!res.ok) throw await errorFromResponse(res);
    try { return await res.json(); } catch { throw remoteError('upstream_error', SAMPLE_ERROR_TEXT.upstream_error, { detail: 'health 응답이 JSON이 아닙니다' }); }
  };

  /** { maxPromptBytes } — health의 limits에서 (성공하면 캐시, 실패하면 기본값) */
  fn.limits = async function limits() {
    if (limitsCache) return limitsCache;
    try {
      const h = await fn.health();
      const n = Number(h?.limits?.maxPromptBytes);
      limitsCache = { maxPromptBytes: Number.isFinite(n) && n > 0 ? n : DEFAULT_MAX_PROMPT_BYTES };
      return limitsCache;
    } catch {
      return { maxPromptBytes: DEFAULT_MAX_PROMPT_BYTES };
    }
  };

  fn.acceptsSchema = true;
  return fn;
}
