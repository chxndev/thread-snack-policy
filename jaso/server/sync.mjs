// 기기 간 동기화 저장소: 클라이언트가 동기화 코드로 만든 키로 암호화한 덩어리(base64url)를 그대로 보관한다.
// 서버는 평문을 보지 못하고, 레코드 하나 = 파일 하나(<id>.json). 쓰기는 임시 파일 + rename 으로 원자적이다.
// 순수 검증 함수들과 작은 파일 IO 저장소(createSyncStore)만 있고 HTTP 처리는 server.mjs 가 한다.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { RequestError } from './lib.mjs';

export const SYNC_ID_RE = /^[a-f0-9]{32}$/;
export const SYNC_PAYLOAD_RE = /^[A-Za-z0-9_-]+$/;
const FILE_RE = /^[a-f0-9]{32}\.json$/;
const TMP_RE = /\.tmp$/;

/** 저장 내용의 ETag: sha256(payload) 앞 32자 */
export function etagOf(payload) {
  return crypto.createHash('sha256').update(String(payload ?? ''), 'utf8').digest('hex').slice(0, 32);
}

/** If-Match / If-None-Match 헤더 → 태그 목록 (따옴표·W/ 제거, '*' 포함) */
export function parseEtagList(header) {
  const h = Array.isArray(header) ? header.join(',') : header;
  if (typeof h !== 'string' || !h.trim()) return [];
  return h.split(',').map((s) => s.trim().replace(/^W\//i, '').replace(/^"(.*)"$/, '$1').trim()).filter(Boolean);
}

/** 헤더의 태그 목록이 etag 와 일치하는지 ('*' 는 레코드가 있으면 일치) */
export function etagMatches(header, etag) {
  const tags = parseEtagList(header);
  if (!tags.length || !etag) return false;
  return tags.some((t) => t === '*' || t === etag);
}

/** 헤더에 담아 보낼 형태 */
export function quoteEtag(etag) {
  return `"${String(etag)}"`;
}

/**
 * PUT 본문 검증 → { payload, updatedAt }. 잘못되면 RequestError(400 invalid_request / 413 prompt_too_large).
 * payload 는 base64url 문자열만(^[A-Za-z0-9_-]+$), 바이트 길이가 maxBytes 를 넘으면 413.
 */
export function validateSyncBody(raw, maxBytes) {
  let body;
  try { body = typeof raw === 'string' || Buffer.isBuffer(raw) ? JSON.parse(raw.toString('utf8')) : raw; } catch { throw new RequestError(400, 'invalid_request', { detail: 'body is not JSON' }); }
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new RequestError(400, 'invalid_request', { detail: 'body must be an object' });
  const { payload, updatedAt } = body;
  if (typeof payload !== 'string' || !payload) throw new RequestError(400, 'invalid_request', { detail: 'payload must be a non-empty string' });
  if (!SYNC_PAYLOAD_RE.test(payload)) throw new RequestError(400, 'invalid_request', { detail: 'payload must be base64url' });
  const bytes = Buffer.byteLength(payload, 'utf8');
  if (Number.isFinite(Number(maxBytes)) && bytes > Number(maxBytes)) throw new RequestError(413, 'prompt_too_large');
  if (typeof updatedAt !== 'number' || !Number.isFinite(updatedAt) || updatedAt < 0) throw new RequestError(400, 'invalid_request', { detail: 'updatedAt must be a number' });
  return { payload, updatedAt: Math.floor(updatedAt), bytes };
}

/**
 * 파일 기반 저장소. dir 은 0700 으로 만든다. maxItems·ttlDays 가 0 이면 제한·만료 없음.
 * get(id) → 레코드 | null, put(id, {payload, updatedAt, ifMatch}) → { ok, code?('sync_conflict'|'sync_missing'|'sync_full'), record },
 * remove(id), count(), sweep(now) → 지운 개수, init().
 */
export function createSyncStore({ dir, maxBytes = 2097152, maxItems = 200, ttlDays = 180, now = Date.now } = {}) {
  if (!dir) throw new Error('sync store: dir 이 필요합니다');
  const root = path.resolve(String(dir));
  const ids = new Set();
  const locks = new Map();
  const ttlMs = Number(ttlDays) > 0 ? Number(ttlDays) * 86400000 : 0;

  const fileOf = (id) => path.join(root, `${id}.json`);

  /** id 별 직렬화 (If-Match 판정과 쓰기 사이에 다른 쓰기가 끼지 않도록) */
  function withLock(id, fn) {
    const prev = locks.get(id) ?? Promise.resolve();
    const next = prev.then(fn, fn);
    const tail = next.catch(() => {});
    locks.set(id, tail);
    tail.then(() => { if (locks.get(id) === tail) locks.delete(id); });
    return next;
  }

  /** 폴더를 만들고(0700) 기존 레코드 수를 센다. 깨진 임시 파일은 지운다. */
  function init() {
    fs.mkdirSync(root, { recursive: true, mode: 0o700 });
    try { fs.chmodSync(root, 0o700); } catch { /* 권한이 없거나 다른 소유자 — 무시 */ }
    ids.clear();
    for (const name of fs.readdirSync(root)) {
      if (FILE_RE.test(name)) ids.add(name.slice(0, 32));
      else if (TMP_RE.test(name)) { try { fs.unlinkSync(path.join(root, name)); } catch { /* 무시 */ } }
    }
    return ids.size;
  }

  async function readRecord(id) {
    let text;
    try { text = await fs.promises.readFile(fileOf(id), 'utf8'); } catch (err) {
      if (err && err.code === 'ENOENT') { ids.delete(id); return null; }
      throw err;
    }
    try {
      const rec = JSON.parse(text);
      if (!rec || typeof rec !== 'object' || typeof rec.payload !== 'string' || typeof rec.etag !== 'string') return null;
      ids.add(id);
      return rec;
    } catch {
      return null; // 깨진 파일은 없는 것으로 (sweep 이 치운다)
    }
  }

  async function get(id) {
    if (!SYNC_ID_RE.test(String(id))) return null;
    return readRecord(id);
  }

  async function writeRecord(rec) {
    const tmp = path.join(root, `${rec.id}.json.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`);
    const data = JSON.stringify(rec);
    try {
      await fs.promises.writeFile(tmp, data, { encoding: 'utf8', mode: 0o600 });
      await fs.promises.rename(tmp, fileOf(rec.id));
    } catch (err) {
      try { await fs.promises.unlink(tmp); } catch { /* 무시 */ }
      throw err;
    }
  }

  /**
   * 저장. ifMatch 가 있고 기존 레코드의 etag 와 다르면 { ok:false, code:'sync_conflict', record }.
   * ifMatch 가 있는데 레코드가 없으면(다른 기기가 지웠거나 만료됨) { ok:false, code:'sync_missing' } — 지운 사본을 몰래 되살리지 않는다.
   * 새 id 인데 maxItems 에 찼으면 { ok:false, code:'sync_full' }. 성공 → { ok:true, record }.
   */
  function put(id, { payload, updatedAt, ifMatch } = {}) {
    if (!SYNC_ID_RE.test(String(id))) throw new RequestError(400, 'invalid_request', { detail: 'bad id' });
    return withLock(id, async () => {
      const existing = await readRecord(id);
      const conditional = ifMatch !== undefined && ifMatch !== null && ifMatch !== '';
      if (conditional && !existing) return { ok: false, code: 'sync_missing', record: null };
      if (conditional && existing.etag !== ifMatch) {
        return { ok: false, code: 'sync_conflict', record: existing };
      }
      if (!existing && maxItems > 0 && ids.size >= maxItems) return { ok: false, code: 'sync_full', record: null };
      const bytes = Buffer.byteLength(payload, 'utf8');
      if (bytes > maxBytes) throw new RequestError(413, 'prompt_too_large');
      const record = { id, etag: etagOf(payload), updatedAt: Number(updatedAt) || 0, payload, bytes, storedAt: now() };
      await writeRecord(record);
      ids.add(id);
      return { ok: true, record };
    });
  }

  /** 삭제 (없어도 성공) */
  function remove(id) {
    if (!SYNC_ID_RE.test(String(id))) return Promise.resolve(false);
    return withLock(id, async () => {
      ids.delete(id);
      try { await fs.promises.unlink(fileOf(id)); return true; } catch (err) {
        if (err && err.code === 'ENOENT') return false;
        throw err;
      }
    });
  }

  /**
   * storedAt 이 ttlDays 보다 오래된 레코드와 깨진 파일을 지운다. → 지운 개수
   * 레코드마다 같은 잠금을 잡아, 읽고 판정하는 사이에 들어온 새 쓰기를 지우지 않는다.
   */
  async function sweep(t = now()) {
    let removed = 0;
    let names;
    try { names = await fs.promises.readdir(root); } catch { return 0; }
    for (const name of names) {
      if (!FILE_RE.test(name)) continue;
      const id = name.slice(0, 32);
      const gone = await withLock(id, async () => {
        let text;
        try { text = await fs.promises.readFile(fileOf(id), 'utf8'); } catch (err) {
          if (err && err.code === 'ENOENT') ids.delete(id);
          return false;
        }
        let rec = null;
        try { rec = JSON.parse(text); } catch { rec = null; }
        const broken = !rec || typeof rec !== 'object' || typeof rec.payload !== 'string';
        const expired = ttlMs > 0 && !broken && Number.isFinite(Number(rec.storedAt)) && Number(rec.storedAt) + ttlMs < t;
        if (!broken && !expired) { ids.add(id); return false; }
        try { await fs.promises.unlink(fileOf(id)); ids.delete(id); return true; } catch { return false; }
      }).catch(() => false);
      if (gone) removed += 1;
    }
    return removed;
  }

  return { dir: root, maxBytes, maxItems, ttlDays, init, get, put, remove, sweep, count: () => ids.size };
}
