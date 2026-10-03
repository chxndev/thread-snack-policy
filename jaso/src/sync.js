// 기기 간 동기화: 사용자의 동기화 코드에서 파생한 키로 브라우저 안에서 암호화하고,
// 운영자 서버(../api/sync/:id)에는 암호문(base64url)만 둔다 — 서버는 평문을 보지 못한다.
// Node 단위 테스트에서도 불러올 수 있도록 DOM 없이 globalThis.crypto.subtle 만 쓰고, location/fetch 는 호출 시점에만 참조한다.
import { SAMPLE_ERROR_TEXT } from './llm-sample.js';

/** 헷갈리는 글자(0/o, 1/l/i)를 뺀 31개 기호. 16개 = 약 79비트 */
export const SYNC_ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789';
const CODE_LEN = 16;
const ID_RE = /^[a-f0-9]{32}$/;
const PAYLOAD_RE = /^[A-Za-z0-9_-]+$/;
const KEY_SALT = 'jaso-sync-key-v1';
const KEY_ITERATIONS = 150000;
const PAYLOAD_VERSION = 1;

export const SYNC_ERROR_TEXT = Object.freeze({
  sync_badcode: '동기화 코드 형식이 올바르지 않습니다. jaso-xxxx-xxxx-xxxx-xxxx 형식이어야 합니다.',
  sync_badkey: '동기화 코드가 맞지 않아 내용을 풀 수 없습니다.',
  sync_corrupt: '서버의 동기화 자료가 손상되어 읽을 수 없습니다.',
  sync_version: '다른 기기의 페이지 버전이 더 새롭습니다. 이 페이지를 새로고침한 뒤 다시 시도해 주세요.',
  sync_conflict: '다른 기기에서 먼저 저장한 내용이 있습니다.',
  sync_full: '서버의 동기화 저장 공간이 가득 찼습니다. 운영자에게 알려 주세요.',
  sync_too_large: '프로젝트가 너무 커서 동기화할 수 없습니다(2MB 제한).',
  sync_disabled: '이 서버에서는 기기 간 동기화를 사용할 수 없습니다.',
  sync_missing: '서버에 이 코드의 동기화 사본이 없습니다(다른 기기에서 삭제했거나 오래되어 만료됨).',
});

const syncError = (code, message, extra = {}) => ({ code, message: message || SYNC_ERROR_TEXT[code] || SAMPLE_ERROR_TEXT[code] || SAMPLE_ERROR_TEXT.upstream_error, ...extra });
const subtle = () => globalThis.crypto.subtle;
const utf8 = (s) => new TextEncoder().encode(s);
const hex = (bytes) => [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
const formatCode = (symbols) => `jaso-${symbols.match(/.{4}/g).join('-')}`;

// ───────────── 코드 ─────────────

/** 새 동기화 코드 `jaso-xxxx-xxxx-xxxx-xxxx` (편향 없는 추출: 알파벳 길이의 배수를 넘는 바이트는 버린다) */
export function generateSyncCode() {
  const limit = 256 - (256 % SYNC_ALPHABET.length);
  let out = '';
  while (out.length < CODE_LEN) {
    const bytes = globalThis.crypto.getRandomValues(new Uint8Array(32));
    for (const b of bytes) if (out.length < CODE_LEN && b < limit) out += SYNC_ALPHABET[b % SYNC_ALPHABET.length];
  }
  return formatCode(out);
}

/** 입력한 코드를 정규형으로: 소문자, 공백·대시 제거, `jaso` 접두사 허용, 4개씩 재그룹. 16개 유효 기호가 아니면 null */
export function normalizeSyncCode(s) {
  if (typeof s !== 'string') return null;
  let t = s.trim().toLowerCase().replace(/[\s\-_.]+/g, '');
  if (t.length === CODE_LEN + 4 && t.startsWith('jaso')) t = t.slice(4);
  if (t.length !== CODE_LEN) return null;
  for (const c of t) if (!SYNC_ALPHABET.includes(c)) return null;
  return formatCode(t);
}

// ───────────── 키 파생·암호화 ─────────────

/**
 * 코드 → { id, key }. id = SHA-256('jaso-sync-id:' + 정규형 코드) 앞 16바이트의 hex(32자), 서버 경로에 쓴다.
 * key = PBKDF2(정규형 코드, salt 'jaso-sync-key-v1', 150000회, SHA-256) → AES-GCM 256 (추출 불가).
 */
export async function deriveSync(code) {
  const norm = normalizeSyncCode(code);
  if (!norm) throw syncError('sync_badcode');
  const digest = new Uint8Array(await subtle().digest('SHA-256', utf8(`jaso-sync-id:${norm}`)));
  const id = hex(digest.slice(0, 16));
  const material = await subtle().importKey('raw', utf8(norm), 'PBKDF2', false, ['deriveKey']);
  const key = await subtle().deriveKey(
    { name: 'PBKDF2', salt: utf8(KEY_SALT), iterations: KEY_ITERATIONS, hash: 'SHA-256' },
    material,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
  return { id, key };
}

export function toBase64Url(bytes) {
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function fromBase64Url(s) {
  if (typeof s !== 'string' || !PAYLOAD_RE.test(s)) return null;
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (s.length % 4)) % 4);
  try {
    const bin = atob(b64);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  } catch {
    return null;
  }
}

/** obj → base64url( 0x01 || IV 12바이트 || AES-GCM 암호문 ) */
export async function encryptJson(key, obj) {
  const iv = globalThis.crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await subtle().encrypt({ name: 'AES-GCM', iv }, key, utf8(JSON.stringify(obj))));
  const out = new Uint8Array(1 + iv.length + ct.length);
  out[0] = PAYLOAD_VERSION;
  out.set(iv, 1);
  out.set(ct, 1 + iv.length);
  return toBase64Url(out);
}

/** encryptJson 의 역. 키가 다르거나 변조됐으면 { code: 'sync_badkey' }, 형식이 깨졌으면 'sync_corrupt', 모르는 버전이면 'sync_version' */
export async function decryptJson(key, payload) {
  const bytes = fromBase64Url(payload);
  if (!bytes || bytes.length < 1 + 12 + 16) throw syncError('sync_corrupt');
  if (bytes[0] !== PAYLOAD_VERSION) throw syncError(bytes[0] > PAYLOAD_VERSION ? 'sync_version' : 'sync_corrupt');
  let plain;
  try {
    plain = await subtle().decrypt({ name: 'AES-GCM', iv: bytes.subarray(1, 13) }, key, bytes.subarray(13));
  } catch {
    throw syncError('sync_badkey');
  }
  try {
    return JSON.parse(new TextDecoder().decode(plain));
  } catch {
    throw syncError('sync_corrupt');
  }
}

// ───────────── 서버 클라이언트 ─────────────

/** 서버가 JSON 오류 본문을 주지 못했을 때 HTTP 상태로 코드를 추정한다 */
const STATUS_CODES = { 400: 'invalid_request', 401: 'unauthorized', 404: 'not_found', 413: 'sync_too_large', 429: 'rate_limited', 507: 'sync_full' };
const unquote = (s) => (typeof s === 'string' ? s.replace(/^W\//, '').replace(/^"(.*)"$/, '$1') : '');

/**
 * @param {object} [o]
 * @param {string} [o.apiBase]   서버 API 루트 (기본: 페이지 기준 ../api/). 끝에 '/'가 있어야 한다.
 * @param {() => string} [o.getKey]  접속 키 (비어 있으면 Authorization 헤더 생략)
 * @param {typeof fetch} [o.fetchImpl]  테스트용 fetch 대체
 */
export function createSyncClient({ apiBase, getKey = () => '', fetchImpl } = {}) {
  const base = () => apiBase ?? new URL('../api/', location.href).href;
  const doFetch = (url, init) => (fetchImpl ?? globalThis.fetch)(url, init);

  function headers(extra = {}) {
    const h = { Accept: 'application/json', ...extra };
    const key = getKey() || '';
    if (key) h.Authorization = `Bearer ${key}`;
    return h;
  }

  function checkId(id) {
    if (typeof id !== 'string' || !ID_RE.test(id)) throw syncError('invalid_request', SAMPLE_ERROR_TEXT.invalid_request);
    return id;
  }

  async function readJson(res) {
    try { return JSON.parse(await res.text()); } catch { return null; }
  }

  /** !res.ok 응답 → 오류 객체. 413은 항상 sync_too_large 문구(서버의 prompt_too_large 문구는 자소서 입력 기준이라 맞지 않는다) */
  async function errorFromResponse(res) {
    const body = await readJson(res);
    let code = (typeof body?.code === 'string' && body.code) || STATUS_CODES[res.status] || 'upstream_error';
    if (res.status === 413 || code === 'prompt_too_large') code = 'sync_too_large';
    const message = (code !== 'sync_too_large' && typeof body?.message === 'string' && body.message) || SYNC_ERROR_TEXT[code] || SAMPLE_ERROR_TEXT[code] || `서버 오류 (HTTP ${res.status})`;
    const err = syncError(code, message, { status: res.status });
    for (const k of ['retryAfterSec', 'resetsAt', 'detail']) if (body?.[k] != null) err[k] = body[k];
    return err;
  }

  async function send(url, init) {
    try {
      return await doFetch(url, init);
    } catch (e) {
      throw syncError('network', SAMPLE_ERROR_TEXT.network, { detail: e?.message ?? String(e) });
    }
  }

  /** GET → { status:'ok', etag, updatedAt, payload } | { status:'notmodified' } | { status:'missing' } */
  async function get(id, { etag = '' } = {}) {
    const url = `${base()}sync/${checkId(id)}`;
    const res = await send(url, { method: 'GET', headers: headers(etag ? { 'If-None-Match': `"${etag}"` } : {}), cache: 'no-store' });
    if (res.status === 304) return { status: 'notmodified' };
    if (res.status === 404) {
      // 기록 없음. (동기화 API 자체가 꺼진 서버인지는 health 의 sync.enabled 로 미리 가려낸다 — 404 본문으로는 구분할 수 없다)
      const body = await readJson(res);
      if (body?.code && body.code !== 'not_found') throw syncError(body.code, typeof body.message === 'string' ? body.message : '', { status: 404 });
      return { status: 'missing' };
    }
    if (!res.ok) throw await errorFromResponse(res);
    const json = await readJson(res);
    if (!json || typeof json.payload !== 'string') throw syncError('upstream_error', SAMPLE_ERROR_TEXT.upstream_error, { detail: '동기화 응답이 JSON이 아닙니다' });
    return { status: 'ok', etag: String(json.etag || unquote(res.headers?.get?.('etag')) || ''), updatedAt: Number(json.updatedAt) || 0, payload: json.payload };
  }

  /**
   * PUT → { status:'ok', etag, updatedAt } | { status:'conflict', etag, updatedAt, payload } (412, If-Match 불일치)
   *     | { status:'missing' } (412 sync_missing: If-Match 를 걸었는데 서버 사본이 없음 — 다른 기기가 지웠거나 만료됨)
   */
  async function put(id, { payload, updatedAt, ifMatch = '' } = {}) {
    const url = `${base()}sync/${checkId(id)}`;
    if (typeof payload !== 'string' || !PAYLOAD_RE.test(payload)) throw syncError('invalid_request', SAMPLE_ERROR_TEXT.invalid_request);
    const h = headers({ 'Content-Type': 'application/json' });
    if (ifMatch) h['If-Match'] = `"${ifMatch}"`;
    const res = await send(url, { method: 'PUT', headers: h, body: JSON.stringify({ payload, updatedAt: Number(updatedAt) || Date.now() }) });
    if (res.status === 412) {
      const body = await readJson(res);
      if (body?.code === 'sync_missing') return { status: 'missing' };
      return { status: 'conflict', etag: String(body?.etag ?? ''), updatedAt: Number(body?.updatedAt) || 0, payload: typeof body?.payload === 'string' ? body.payload : '' };
    }
    if (!res.ok) throw await errorFromResponse(res);
    const json = await readJson(res);
    return { status: 'ok', etag: String(json?.etag || unquote(res.headers?.get?.('etag')) || ''), updatedAt: Number(json?.updatedAt) || Number(updatedAt) || 0 };
  }

  /** DELETE → true (204; 404 도 성공으로 본다) */
  async function remove(id) {
    const url = `${base()}sync/${checkId(id)}`;
    const res = await send(url, { method: 'DELETE', headers: headers() });
    if (res.status === 204 || res.status === 404 || res.ok) return true;
    throw await errorFromResponse(res);
  }

  return { get, put, remove };
}
