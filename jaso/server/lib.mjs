// jaso 운영자 구독 서버 — 순수 헬퍼 모음 (import 시 부작용 없음, 단위 테스트 대상)
// 서버(server.mjs)와 테스트용 가짜 CLI(test/helpers/fake-claude-cli.mjs)가 함께 쓴다.
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import net from 'node:net';
import { StringDecoder } from 'node:string_decoder';
import { fileURLToPath } from 'node:url';
import { CONTENT_FLAGS, parseGuardMode, DEFAULT_MANAGED_FILE } from './telemetry-guard.mjs';

/** Claude Code CLI에 넘기는 시스템 프롬프트 */
export const SYSTEM_PROMPT = '당신은 자기소개서 작성 도우미입니다. 사용자 메시지의 [역할과 규칙]과 [요청]을 그대로 따르고, 요청된 결과물만 출력하세요. 도구를 쓰거나 파일을 읽지 말고, 머리말·맺음말·설명을 덧붙이지 마세요. 대화 기록이 주어지면 마지막 사용자 발화에 대한 응답만 작성하세요.';

/** 등급별 기본 모델·노력 수준 (환경 변수로 덮어쓴다) */
export const TIERS = Object.freeze({
  complex: Object.freeze({ model: 'opus', effort: 'high' }),
  default: Object.freeze({ model: 'sonnet', effort: 'medium' }),
  quick: Object.freeze({ model: 'sonnet', effort: 'low' }),
});
export const TIER_NAMES = Object.freeze(Object.keys(TIERS));
export const EFFORTS = Object.freeze(['low', 'medium', 'high', 'xhigh', 'max']);

/** 클라이언트에 그대로 보여 주는 한국어 오류 문구. {n}·{시각} 자리는 errorMessage()가 채운다. */
export const ERROR_TEXT = Object.freeze({
  invalid_request: '요청 형식이 올바르지 않습니다. 페이지를 새로고침한 뒤 다시 시도해 주세요.',
  unauthorized: '접속 키가 올바르지 않습니다.',
  prompt_too_large: '보내는 내용이 너무 깁니다. 경험 카드나 공고 내용을 줄여 주세요.',
  rate_limited: '요청이 너무 많습니다. {n}초 후 다시 시도해 주세요.',
  usage_limit: '운영자 Claude 구독의 사용량 한도에 걸렸습니다. {시각} 이후 다시 시도해 주세요.',
  usage_limit_unknown: '운영자 Claude 구독의 사용량 한도에 걸렸습니다. 잠시 후 다시 시도해 주세요.',
  refused: 'Claude가 이 요청을 거절했습니다. 표현을 바꿔 다시 시도해 주세요.',
  empty_completion: 'Claude가 답을 내지 못했습니다. 입력을 줄이거나 다시 시도해 주세요.',
  invalid_json: '응답을 JSON으로 해석하지 못했습니다. 다시 시도해 주세요.',
  upstream_error: '일시적인 오류입니다. 잠시 후 다시 시도해 주세요.',
  nologin: '운영자의 Claude 로그인이 만료되었거나 설정되지 않았습니다. 운영자에게 알려 주세요.',
  busy: '지금 다른 요청을 처리하고 있습니다. 잠시 후 다시 시도해 주세요.',
  timeout: '응답이 너무 오래 걸립니다. 운영자의 Claude 로그인 상태를 확인해야 할 수 있습니다.',
  telemetry_blocked: '운영자 조직의 Claude 텔레메트리 설정이 프롬프트·답변 본문 수집을 켜 두어 호출을 중단했습니다. 운영자에게 알려 주세요.',
  // 같은 telemetry_blocked 코드이지만 strict 모드에서 조직 설정을 확인하지 못해(unknown) 거절할 때의 문구 — 수집이 켜졌다고 단정하지 않는다
  telemetry_unverified: '운영자 조직의 텔레메트리 설정을 확인할 수 없어(엄격 모드) 호출을 중단했습니다. 운영자에게 알려 주세요.',
  sync_conflict: '다른 기기에서 먼저 저장한 내용이 있어 이번 저장을 적용하지 않았습니다.',
  sync_full: '서버의 동기화 저장 공간이 가득 찼습니다. 운영자에게 알려 주세요.',
  sync_missing: '서버에 이 코드의 동기화 사본이 없습니다(다른 기기에서 삭제했거나 오래되어 만료됨).',
  not_found: '요청한 경로가 없습니다.',
  method_not_allowed: '허용되지 않는 요청 방식입니다.',
  internal: '서버 내부 오류입니다. 잠시 후 다시 시도해 주세요.',
});

/** epoch 초 → ko-KR 로컬 시각 문자열 (ICU가 없으면 ISO로 대체) */
export function formatKoTime(epochSec) {
  const n = Number(epochSec);
  if (!Number.isFinite(n) || n <= 0) return '';
  const d = new Date(n * 1000);
  try {
    return d.toLocaleString('ko-KR', { dateStyle: 'medium', timeStyle: 'short' });
  } catch {
    return d.toISOString();
  }
}

/** 오류 코드 + 부가 정보 → 사용자에게 보여 줄 문구 */
export function errorMessage(code, { retryAfterSec, resetsAt, guardStatus } = {}) {
  if (code === 'telemetry_blocked' && guardStatus === 'unknown') return ERROR_TEXT.telemetry_unverified;
  if (code === 'usage_limit') {
    const when = formatKoTime(resetsAt);
    return when ? ERROR_TEXT.usage_limit.replace('{시각}', when) : ERROR_TEXT.usage_limit_unknown;
  }
  if (code === 'rate_limited') return ERROR_TEXT.rate_limited.replace('{n}', String(Math.max(1, Math.ceil(Number(retryAfterSec) || 1))));
  return ERROR_TEXT[code] ?? ERROR_TEXT.upstream_error;
}

/** 서버가 응답으로 바꿀 실패 객체: { status, code, message, resetsAt?, retryAfterSec?, detail?, flags?, guardStatus? } */
export function makeFailure(status, code, extra = {}) {
  const out = { status, code, message: errorMessage(code, extra) };
  if (extra.resetsAt !== undefined && Number.isFinite(Number(extra.resetsAt))) out.resetsAt = Number(extra.resetsAt);
  if (extra.retryAfterSec !== undefined) out.retryAfterSec = Math.max(1, Math.ceil(Number(extra.retryAfterSec) || 1));
  if (extra.detail) out.detail = String(extra.detail).slice(0, 300);
  if (Array.isArray(extra.flags)) out.flags = extra.flags.map(String);
  if (extra.guardStatus) out.guardStatus = String(extra.guardStatus); // telemetry_blocked: 'blocked' | 'unknown'(strict)
  return out;
}

/** 요청 처리 중 던지는 오류 (status/code를 가진다) */
export class RequestError extends Error {
  constructor(status, code, extra = {}) {
    const f = makeFailure(status, code, extra);
    super(f.message);
    this.name = 'RequestError';
    this.failure = f;
    this.status = f.status;
    this.code = f.code;
  }
}

// ───────────── 설정 ─────────────

function parseNameList(v) {
  return String(v ?? '')
    .split(/[,\s]+/)
    .map((s) => s.trim())
    .filter((s) => /^[A-Z_][A-Z0-9_]*$/.test(s));
}

/** 환경 변수 → 설정 객체. 잘못된 값은 기본값으로 떨어진다. */
export function parseConfig(env = {}) {
  const int = (v, d, min = 0) => {
    if (v === undefined || v === '') return d;
    const n = Number.parseInt(String(v), 10);
    return Number.isFinite(n) && n >= min ? n : d;
  };
  const str = (v, d) => (v === undefined || v === '' ? d : String(v));
  const flag = (v) => String(v ?? '').trim() === '1';
  const effort = (v, d) => (EFFORTS.includes(String(v ?? '').trim()) ? String(v).trim() : d);
  const defaultRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
  const tier = (name, d) => ({
    model: str(env[`JASO_MODEL_${name}`], d.model).trim() || d.model,
    effort: effort(env[`JASO_EFFORT_${name}`], d.effort),
  });
  // 자식 CLI 추가 통과 목록: 접속 키·API 키·본문 텔레메트리 플래그는 거절한다 (서버가 시작 시 경고를 남긴다)
  const passthroughAll = parseNameList(env.JASO_CHILD_ENV_PASSTHROUGH);
  const home = str(env.HOME, os.homedir());
  return {
    host: str(env.JASO_HOST, '127.0.0.1'),
    port: int(env.JASO_PORT, 8080, 0),
    accessKey: String(env.JASO_ACCESS_KEY ?? '').trim(),
    allowAnon: flag(env.JASO_ALLOW_ANON),
    claudeBin: str(env.JASO_CLAUDE_BIN, 'claude'),
    root: path.resolve(str(env.JASO_ROOT, defaultRoot)),
    concurrency: int(env.JASO_CONCURRENCY, 1, 1),
    maxQueue: int(env.JASO_MAX_QUEUE, 6, 0),
    rateLimit: str(env.JASO_RATE_LIMIT, '40/600'),
    authFailLimit: str(env.JASO_AUTH_FAIL_LIMIT, '10/600'),
    maxInputBytes: int(env.JASO_MAX_INPUT_BYTES, 300000, 1),
    maxBodyBytes: int(env.JASO_MAX_BODY_BYTES, 1048576, 1),
    trustProxy: flag(env.JASO_TRUST_PROXY),
    firstOutputTimeoutMs: int(env.JASO_FIRST_OUTPUT_TIMEOUT_MS, 120000, 1),
    totalTimeoutMs: int(env.JASO_TOTAL_TIMEOUT_MS, 600000, 1),
    tiers: {
      complex: tier('COMPLEX', TIERS.complex),
      default: tier('DEFAULT', TIERS.default),
      quick: tier('QUICK', TIERS.quick),
    },
    // 빈 문자열이면 폴백 모델을 쓰지 않는다
    fallbackModel: env.JASO_FALLBACK_MODEL === undefined ? 'sonnet' : String(env.JASO_FALLBACK_MODEL).trim(),
    workDir: str(env.JASO_WORK_DIR, path.join(os.tmpdir(), 'jaso-work')),
    loginProbe: env.JASO_LOGIN_PROBE === undefined || env.JASO_LOGIN_PROBE === '' ? true : flag(env.JASO_LOGIN_PROBE),
    allowApiKey: flag(env.JASO_ALLOW_API_KEY),
    logLevel: str(env.JASO_LOG_LEVEL, 'info'),
    // 자식 CLI에 추가로 넘길 환경 변수 이름들 (예: 사내 프록시 HTTPS_PROXY, 테스트의 FAKE_*)
    childEnvPassthrough: passthroughAll.filter((k) => !ENV_NEVER.has(k)),
    childEnvPassthroughRefused: passthroughAll.filter((k) => ENV_NEVER.has(k)),
    // 텔레메트리 가드 (telemetry-guard.mjs)
    telemetryGuard: parseGuardMode(env.JASO_TELEMETRY_GUARD),
    claudeConfigDir: path.resolve(str(env.JASO_CLAUDE_CONFIG_DIR, str(env.CLAUDE_CONFIG_DIR, path.join(home, '.claude')))),
    telemetryRecheckMs: int(env.JASO_TELEMETRY_RECHECK_MS, 3600000, 1000),
    managedSettingsFile: str(env.JASO_MANAGED_SETTINGS_FILE, DEFAULT_MANAGED_FILE),
    // 기기 간 동기화 저장소 (sync.mjs)
    dataDir: path.resolve(str(env.JASO_DATA_DIR, path.join(os.homedir(), '.local', 'share', 'jaso', 'sync'))),
    syncEnabled: env.JASO_SYNC === undefined || env.JASO_SYNC === '' ? true : String(env.JASO_SYNC).trim() !== '0',
    syncMaxBytes: int(env.JASO_SYNC_MAX_BYTES, 2097152, 1),
    syncMaxItems: int(env.JASO_SYNC_MAX_ITEMS, 200, 0),
    syncTtlDays: int(env.JASO_SYNC_TTL_DAYS, 180, 0),
    syncRateLimit: str(env.JASO_SYNC_RATE_LIMIT, '120/600'),
  };
}

// ───────────── 입력 평탄화 ─────────────

const HISTORY_HEADER = '[대화 기록] 아래는 지금까지의 대화입니다. 마지막 user 발화에 대한 assistant 응답만 출력하세요.';
const ROLE_MARK = { user: '[[USER]]', assistant: '[[ASSISTANT]]' };

function badInput(detail) {
  return new RequestError(400, 'invalid_request', { detail });
}

/**
 * 요청의 input(문자열 또는 {role, content}[]) → CLI stdin에 넣을 프롬프트 한 덩어리.
 * 메시지 배열은 마지막이 user 턴이어야 한다. 잘못되면 RequestError(400 invalid_request).
 * @returns {{ prompt: string, kind: 'string'|'messages', bytes: number }}
 */
export function flattenInput(input) {
  if (typeof input === 'string') {
    if (!input.trim()) throw badInput('input is empty');
    return { prompt: input, kind: 'string', bytes: Buffer.byteLength(input, 'utf8') };
  }
  if (!Array.isArray(input) || input.length === 0) throw badInput('input must be a string or a non-empty array');
  let bytes = 0;
  const turns = input.map((m, i) => {
    if (!m || typeof m !== 'object' || Array.isArray(m)) throw badInput(`messages[${i}] is not an object`);
    if (m.role !== 'user' && m.role !== 'assistant') throw badInput(`messages[${i}].role is invalid`);
    if (typeof m.content !== 'string') throw badInput(`messages[${i}].content must be a string`);
    bytes += Buffer.byteLength(m.content, 'utf8');
    return { role: m.role, content: m.content };
  });
  if (turns[turns.length - 1].role !== 'user') throw badInput('messages must end with a user turn');
  const body = turns.map((t) => `${ROLE_MARK[t.role]}\n${t.content}`).join('\n\n');
  return { prompt: `${HISTORY_HEADER}\n\n${body}`, kind: 'messages', bytes };
}

/** flattenInput의 역변환: 마커가 있으면 메시지 배열, 없으면 문자열 그대로 (가짜 CLI가 쓴다) */
export function unflattenInput(text) {
  const s = String(text ?? '');
  if (!s.startsWith(HISTORY_HEADER)) return s;
  const rest = s.slice(HISTORY_HEADER.length).replace(/^\n\n/, '');
  const re = /^\[\[(USER|ASSISTANT)\]\]$/gm;
  const marks = [];
  let m;
  while ((m = re.exec(rest))) marks.push({ role: m[1] === 'USER' ? 'user' : 'assistant', start: m.index, end: m.index + m[0].length });
  if (!marks.length) return s;
  return marks.map((mk, i) => {
    const next = marks[i + 1];
    let content = rest.slice(mk.end, next ? next.start : rest.length);
    content = content.replace(/^\n/, '');
    if (next) content = content.replace(/\n\n$/, '');
    return { role: mk.role, content };
  });
}

// ───────────── 자식 프로세스 인자·환경 ─────────────

/** `claude -p` 인자 목록 (순서 고정) */
export function buildArgs({ model, effort, schema, fallbackModel, systemPrompt = SYSTEM_PROMPT } = {}) {
  const args = [
    '-p',
    '--output-format', 'stream-json',
    '--verbose',
    '--include-partial-messages',
    '--tools', '',
    '--no-session-persistence',
    '--permission-prompts', 'none',
    '--disable-slash-commands',
    '--strict-mcp-config',
    '--setting-sources', '',
    '--model', String(model),
    '--effort', String(effort),
    '--system-prompt', String(systemPrompt),
  ];
  if (fallbackModel && fallbackModel !== model) args.push('--fallback-model', String(fallbackModel));
  if (schema && typeof schema === 'object') args.push('--json-schema', JSON.stringify(schema));
  return args;
}

const ENV_PASS = ['HOME', 'PATH', 'USER', 'LOGNAME', 'LANG', 'LC_ALL', 'TMPDIR', 'CLAUDE_CONFIG_DIR', 'CLAUDE_CODE_OAUTH_TOKEN'];
const ENV_API_KEYS = ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN'];
// 어떤 경우에도 자식에 넘기지 않는 이름: API 키, 접속 키, 본문을 내보내는 OTEL 플래그 다섯 개
const ENV_NEVER = new Set([...ENV_API_KEYS, 'JASO_ACCESS_KEY', ...CONTENT_FLAGS]);

/** 자식 CLI 환경: 화이트리스트만 통과시키고 텔레메트리·자동 업데이트를 끈다 */
export function childEnv(env = {}, cfg = {}) {
  const out = {};
  for (const k of ENV_PASS) if (env[k] !== undefined) out[k] = env[k];
  for (const k of cfg.childEnvPassthrough ?? []) {
    if (ENV_NEVER.has(k)) continue;
    if (env[k] !== undefined) out[k] = env[k];
  }
  if (cfg.allowApiKey) for (const k of ENV_API_KEYS) if (env[k] !== undefined) out[k] = env[k];
  Object.assign(out, {
    TERM: 'dumb',
    NO_COLOR: '1',
    DISABLE_TELEMETRY: '1',
    DISABLE_ERROR_REPORTING: '1',
    DISABLE_AUTOUPDATER: '1',
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
  });
  return out;
}

/** JASO_CLAUDE_BIN → spawn 명령. .mjs/.js면 현재 node로 실행한다(테스트용 가짜 CLI). */
export function spawnSpec(bin, execPath = process.execPath) {
  const b = String(bin || 'claude');
  if (/\.(mjs|cjs|js)$/i.test(b)) return { cmd: execPath, prefix: [b] };
  return { cmd: b, prefix: [] };
}

// ───────────── stream-json 파서 ─────────────

/**
 * CLI stdout(stream-json, 한 줄에 JSON 하나)을 조각 단위로 받아 이벤트 배열을 돌려준다.
 * 조각난 줄·JSON이 아닌 줄·모르는 type은 무시한다.
 * 이벤트: {type:'first_output'} (모델 출력 첫 줄) · {type:'delta', text} · {type:'stop', stopReason}
 *        · {type:'rateLimit', info} · {type:'assistant', message} · {type:'result', result}
 */
export function createStreamParser() {
  const decoder = new StringDecoder('utf8');
  let buf = '';
  let sawOutput = false;

  function handleLine(line, out) {
    const t = line.trim();
    if (!t || t[0] !== '{') return;
    let obj;
    try { obj = JSON.parse(t); } catch { return; }
    if (!obj || typeof obj !== 'object') return;
    const type = obj.type;
    if ((type === 'stream_event' || type === 'assistant' || type === 'result') && !sawOutput) {
      sawOutput = true;
      out.push({ type: 'first_output' });
    }
    if (type === 'stream_event') {
      const ev = obj.event ?? {};
      if (ev.type === 'content_block_delta') {
        const d = ev.delta ?? {};
        if (d.type === 'text_delta' && typeof d.text === 'string') out.push({ type: 'delta', text: d.text });
        else if (d.type === 'input_json_delta' && typeof d.partial_json === 'string') out.push({ type: 'delta', text: d.partial_json });
      } else if (ev.type === 'message_delta' && ev.delta && typeof ev.delta.stop_reason === 'string') {
        out.push({ type: 'stop', stopReason: ev.delta.stop_reason });
      }
    } else if (type === 'rate_limit_event') {
      if (obj.rate_limit_info && typeof obj.rate_limit_info === 'object') out.push({ type: 'rateLimit', info: obj.rate_limit_info });
    } else if (type === 'assistant') {
      out.push({ type: 'assistant', message: obj.message ?? null });
    } else if (type === 'result') {
      out.push({ type: 'result', result: obj });
    }
  }

  return {
    feed(chunk) {
      buf += Buffer.isBuffer(chunk) ? decoder.write(chunk) : String(chunk ?? '');
      const out = [];
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        handleLine(buf.slice(0, i), out);
        buf = buf.slice(i + 1);
      }
      return out;
    },
    end() {
      buf += decoder.end();
      const out = [];
      if (buf) handleLine(buf, out);
      buf = '';
      return out;
    },
    get sawOutput() { return sawOutput; },
  };
}

// ───────────── 실패 분류 ─────────────

const NOLOGIN_RE = /not logged in|please run \/login|authentication|invalid api key|oauth.*(expired|invalid|revoked)|\b401\b/i;
const USAGE_RE = /usage limit|rate limit|out of .*(usage|quota)|limit reached/i;

/** stderr에서 색상 코드·비밀값을 지우고 마지막 300자만 남긴다 */
export function sanitizeStderr(s, max = 300) {
  let t = String(s ?? '')
    .replace(/\x1b\[[0-9;]*[A-Za-z]/g, '')
    .replace(/sk-ant-[A-Za-z0-9_-]+/g, '[redacted]')
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [redacted]')
    .replace(/\b(token|key|secret|password|authorization|api[_-]?key)\b(\s*[=:]\s*)[^\s,;"']+/gi, '$1$2[redacted]')
    .replace(/\s+/g, ' ')
    .trim();
  if (t.length > max) t = t.slice(t.length - max);
  return t;
}

/**
 * 자식 결과 → 실패 객체 또는 null(성공으로 계속 처리).
 * 입력: { result, stderr, exitCode, lastRateLimit, timedOut }
 */
export function classifyFailure({ result, stderr = '', exitCode = null, lastRateLimit = null, timedOut = false } = {}) {
  if (timedOut) return makeFailure(504, 'timeout');
  const errTail = sanitizeStderr(stderr);
  const resultText = result && typeof result.result === 'string' ? result.result : '';
  const haystack = `${resultText}\n${String(stderr ?? '')}`;
  const rlStatus = lastRateLimit && typeof lastRateLimit.status === 'string' ? lastRateLimit.status : '';
  // 'allowed_warning'(한도 임박 경고)은 정상 상태이므로 명시적으로 'rejected'만 한도 초과로 본다
  const rlRejected = rlStatus === 'rejected';
  const resetsAt = lastRateLimit && Number.isFinite(Number(lastRateLimit.resetsAt)) && Number(lastRateLimit.resetsAt) > 0 ? Number(lastRateLimit.resetsAt) : undefined;

  if (result && typeof result === 'object') {
    if (result.is_error) {
      if (rlRejected || result.api_error_status === 429) return makeFailure(429, 'usage_limit', { resetsAt });
      if (result.api_error_status === 401 || NOLOGIN_RE.test(haystack)) return makeFailure(503, 'nologin', { detail: errTail });
      if (USAGE_RE.test(haystack)) return makeFailure(429, 'usage_limit', { resetsAt });
      return makeFailure(502, 'upstream_error', { detail: errTail || sanitizeStderr(resultText) });
    }
    if (result.stop_reason === 'refusal') return makeFailure(422, 'refused');
    return null;
  }
  // result 줄이 없음: 비정상 종료·출력 해석 실패
  if (NOLOGIN_RE.test(String(stderr ?? ''))) return makeFailure(503, 'nologin', { detail: errTail });
  if (rlRejected || USAGE_RE.test(String(stderr ?? ''))) return makeFailure(429, 'usage_limit', { resetsAt });
  return makeFailure(502, 'upstream_error', { detail: errTail || `exit ${exitCode}` });
}

/** result 객체에서 최종 텍스트: result.result가 비어 있지 않은 문자열이면 그것, 아니면 누적 델타 */
export function pickText(result, accumulated = '') {
  if (result && typeof result.result === 'string' && result.result.trim()) return result.result;
  return String(accumulated ?? '');
}

/** result.modelUsage의 첫 키(실제 모델 id), 없으면 요청한 별칭 */
export function modelIdFrom(result, alias) {
  const mu = result && result.modelUsage;
  if (mu && typeof mu === 'object') {
    const k = Object.keys(mu)[0];
    if (k) return k;
  }
  return String(alias ?? '');
}

/** usage 4개 필드만 숫자로 */
export function usageFrom(result) {
  const u = (result && result.usage) || {};
  const n = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);
  return {
    input_tokens: n(u.input_tokens),
    output_tokens: n(u.output_tokens),
    cache_read_input_tokens: n(u.cache_read_input_tokens),
    cache_creation_input_tokens: n(u.cache_creation_input_tokens),
  };
}

// ───────────── 인증·속도 제한 ─────────────

export function keyDigest(key) {
  return crypto.createHash('sha256').update(String(key ?? ''), 'utf8').digest();
}

/** Authorization 헤더가 접속 키와 일치하는지 (sha256 다이제스트 timingSafeEqual) */
export function checkAuth(header, digest) {
  if (!Buffer.isBuffer(digest) || digest.length !== 32) return false;
  const m = /^\s*Bearer\s+(.+?)\s*$/i.exec(String(header ?? ''));
  if (!m) return false;
  const token = m[1];
  if (!token) return false;
  return crypto.timingSafeEqual(keyDigest(token), digest);
}

/** "count/seconds" → { count, seconds } (잘못되면 기본값) */
export function parseRateSpec(spec, fallback = { count: 40, seconds: 600 }) {
  const m = /^\s*(\d+)\s*\/\s*(\d+)\s*$/.exec(String(spec ?? ''));
  if (!m) return { ...fallback };
  const count = Number(m[1]);
  const seconds = Number(m[2]);
  if (!Number.isFinite(count) || !Number.isFinite(seconds) || seconds <= 0) return { ...fallback };
  return { count, seconds };
}

/**
 * 키(IP)별 슬라이딩 윈도 제한기. count가 0이면 제한 없음.
 * check(key): 기록 없이 판정, hit(key): 통과하면 기록. 둘 다 { ok, retryAfterSec?, remaining? }.
 */
export function createRateLimiter(spec, { now = Date.now } = {}) {
  const { count, seconds } = parseRateSpec(spec);
  const windowMs = seconds * 1000;
  const buckets = new Map();

  function pruned(key, t) {
    let arr = buckets.get(key);
    if (!arr) return [];
    const from = t - windowMs;
    arr = arr.filter((ts) => ts > from);
    if (arr.length) buckets.set(key, arr);
    else buckets.delete(key);
    return arr;
  }
  function check(key, t = now()) {
    if (count <= 0) return { ok: true, remaining: Infinity };
    const arr = pruned(key, t);
    if (arr.length >= count) return { ok: false, retryAfterSec: Math.max(1, Math.ceil((arr[0] + windowMs - t) / 1000)) };
    return { ok: true, remaining: count - arr.length };
  }
  function hit(key, t = now()) {
    const r = check(key, t);
    if (r.ok && count > 0) {
      const arr = buckets.get(key) ?? [];
      arr.push(t);
      buckets.set(key, arr);
    }
    return r;
  }
  function sweep(t = now()) {
    for (const key of [...buckets.keys()]) pruned(key, t);
  }
  return { count, seconds, check, hit, sweep, size: () => buckets.size };
}

// ───────────── 정적 파일·클라이언트 IP ─────────────

export const MIME = Object.freeze({
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
});

export function mimeFor(file) {
  return MIME[path.extname(String(file)).toLowerCase()] ?? 'application/octet-stream';
}

/**
 * URL 경로 → 제공 가능한 절대 파일 경로 또는 null.
 * 허용: /jaso/ 아래(단 /jaso/server/ 제외), 루트의 *.html. 숫점 파일·..·그 외는 거절.
 */
export function resolveStatic(root, urlPath) {
  if (typeof urlPath !== 'string' || !urlPath.startsWith('/')) return null;
  let decoded;
  try { decoded = decodeURIComponent(urlPath); } catch { return null; }
  if (/[\0\\]/.test(decoded)) return null;
  if (decoded === '/jaso/') decoded = '/jaso/index.html';
  const segs = decoded.split('/').slice(1);
  if (!segs.length || segs.some((s) => s === '' || s === '.' || s === '..' || s.startsWith('.'))) return null;
  const rootAbs = path.resolve(String(root));
  const abs = path.resolve(rootAbs, ...segs);
  const rel = path.relative(rootAbs, abs);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return null;
  const relSegs = rel.split(path.sep);
  if (relSegs[0] === 'jaso') {
    if (relSegs.length < 2) return null;
    if (relSegs[1].toLowerCase() === 'server') return null; // 대소문자 구분 없는 파일 시스템(/mnt/c)도 막는다
    return abs;
  }
  if (relSegs.length === 1 && relSegs[0].toLowerCase().endsWith('.html')) return abs;
  return null;
}

function normIp(ip) {
  const s = String(ip ?? '').trim();
  if (!s) return 'unknown';
  return s.startsWith('::ffff:') ? s.slice(7) : s;
}

/**
 * 클라이언트 IP. trustProxy면 CF-Connecting-IP → X-Forwarded-For 의 **마지막** 항목(바로 앞 신뢰 홉이 붙인 값) → 소켓 주소.
 * 첫 항목은 클라이언트가 마음대로 넣을 수 있어 IP 별 제한을 우회할 수 있으므로 쓰지 않는다. IP 형식이 아니면 소켓 주소로 돌아간다.
 * Tailscale Funnel 을 거친 요청(Tailscale-Funnel-Request 헤더)은 CF-Connecting-IP 를 보지 않는다: Funnel 은 이 헤더를 지우지 않아
 * 방문자가 아무 값이나 넣어 IP 별 제한·접속 키 실패 제한을 피할 수 있다. Funnel 이 직접 넣는 X-Forwarded-For 만 믿는다.
 */
export function clientIp(req, trustProxy = false) {
  const h = (req && req.headers) || {};
  const first = (v) => (Array.isArray(v) ? v[0] : v);
  const valid = (v) => { const ip = normIp(v); return ip !== 'unknown' && net.isIP(ip) !== 0 ? ip : null; };
  if (trustProxy) {
    const viaFunnel = h['tailscale-funnel-request'] !== undefined;
    const cf = viaFunnel ? null : valid(first(h['cf-connecting-ip']));
    if (cf) return cf;
    const xff = first(h['x-forwarded-for']);
    if (xff) {
      const parts = String(xff).split(',').map((s) => s.trim()).filter(Boolean);
      const last = valid(parts[parts.length - 1]);
      if (last) return last;
    }
  }
  return normIp(req && req.socket && req.socket.remoteAddress);
}
