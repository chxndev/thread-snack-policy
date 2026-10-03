// 텔레메트리 가드: 조직 Owner 가 Claude Code 에 내려보내는 서버 관리 설정(remote-settings.json)·파일 관리 설정·
// 사용자 설정·서버 자신의 환경 변수에서 "프롬프트·답변·도구 본문 수집" 플래그가 켜져 있는지 검사한다.
// 사용량 통계(메타데이터) 텔레메트리는 허용하고, 본문 수집만 감지해 /api/sample 호출을 막는다.
// 순수 함수(검사·판정) + 작은 IO(설정 파일 읽기, fs.watch)만 있고 서버 상태는 createTelemetryGuard 가 들고 있다.
import fs from 'node:fs';
import path from 'node:path';

/** 본문을 내보내는 OTEL 플래그 다섯 개 (모두 기본 꺼짐) */
export const CONTENT_FLAGS = Object.freeze([
  'OTEL_LOG_USER_PROMPTS',
  'OTEL_LOG_ASSISTANT_RESPONSES',
  'OTEL_LOG_TOOL_DETAILS',
  'OTEL_LOG_TOOL_CONTENT',
  'OTEL_LOG_RAW_API_BODIES',
]);

/** 가드 동작 방식: block(확인된 수집만 차단, 기본) · strict(알 수 없음도 차단) · warn(차단 안 함) · off(검사 안 함) */
export const GUARD_MODES = Object.freeze(['block', 'strict', 'warn', 'off']);

export const REMOTE_CACHE_FILE = 'remote-settings.json';
export const USER_SETTINGS_FILE = 'settings.json';
export const DEFAULT_MANAGED_FILE = '/etc/claude-code/managed-settings.json';

const OFF_VALUES = new Set(['', '0', 'false', 'off', 'no']);
const MAX_DEPTH = 32;

export function parseGuardMode(v) {
  const s = String(v ?? '').trim().toLowerCase();
  return GUARD_MODES.includes(s) ? s : 'block';
}

/**
 * 플래그 값이 "켜짐"인지. ''·'0'·'false'·'off'·'no'(대소문자 무시, 공백 제거)만 꺼짐이고 그 밖의 값은 모두 켜짐.
 * OTEL_LOG_RAW_API_BODIES 의 `file:<dir>` 같은 값도 켜짐으로 본다. undefined/null 은 꺼짐.
 */
export function isFlagOn(value) {
  if (value === undefined || value === null) return false;
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value !== 0;
  if (typeof value !== 'string') return true;
  return !OFF_VALUES.has(value.trim().toLowerCase());
}

/**
 * JSON 안에서 이름이 `env` 이고 값이 객체인 속성을 모두 모은다 (원격 설정 캐시의 형태가 문서화되어 있지 않아
 * 설정 JSON 그 자체이거나 {settings:{...}}·{data:{...}} 로 감싸여 있을 수 있다).
 * @returns {{ path: string, env: object }[]}
 */
export function findEnvBlocks(json) {
  const out = [];
  const seen = new Set();
  const isObj = (v) => v && typeof v === 'object' && !Array.isArray(v);
  const walk = (node, p, depth) => {
    if (!node || typeof node !== 'object' || depth > MAX_DEPTH || seen.has(node)) return;
    seen.add(node);
    if (Array.isArray(node)) {
      node.forEach((v, i) => walk(v, `${p}[${i}]`, depth + 1));
      return;
    }
    for (const [k, v] of Object.entries(node)) {
      const childPath = p ? `${p}.${k}` : k;
      if (k === 'env' && isObj(v)) out.push({ path: childPath, env: v });
      else walk(v, childPath, depth + 1);
    }
  };
  walk(json, '', 0);
  return out;
}

const DOCTOR_REMOTE_RE = /Managed settings \(remote\):\s*(\S+)/i;

/** `claude doctor` 출력에서 "Managed settings (remote): <상태>" 줄 → 'loaded' | 'none' | 'unknown' */
export function parseRemoteManaged(doctorOutput) {
  if (typeof doctorOutput !== 'string' || !doctorOutput) return 'unknown';
  const m = DOCTOR_REMOTE_RE.exec(doctorOutput);
  if (!m) return 'unknown';
  return m[1].toLowerCase().replace(/[^a-z]/g, '') === 'loaded' ? 'loaded' : 'none';
}

/** 설정 파일 하나를 읽어 JSON 으로. 없으면 present:false, 깨졌으면 parseError:true */
function readSettingsFile(file) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (err) {
    if (err && err.code === 'ENOENT') return { present: false, parseError: false, json: null };
    // 권한 문제 등 — 있는데 읽지 못하면 깨진 것과 같이 취급한다
    return { present: true, parseError: true, json: null };
  }
  try {
    const json = JSON.parse(text);
    if (!json || typeof json !== 'object') return { present: true, parseError: true, json: null };
    return { present: true, parseError: false, json };
  } catch {
    return { present: true, parseError: true, json: null };
  }
}

/** 설정 JSON 의 env 블록들에서 켜진 본문 플래그를 모은다. 값은 절대 그대로 넣지 않는다(경로 등 노출 방지). */
function flagsFromJson(json, source) {
  const out = [];
  for (const { env } of findEnvBlocks(json)) {
    for (const key of CONTENT_FLAGS) {
      if (Object.prototype.hasOwnProperty.call(env, key) && isFlagOn(env[key])) out.push({ key, value: '<on>', source });
    }
  }
  return out;
}

/**
 * 텔레메트리 설정을 한 번 검사한다.
 * 검사 순서: configDir/remote-settings.json → managedFile → configDir/settings.json → 서버 프로세스 환경 변수.
 * status: 'blocked'(어디서든 플래그 켜짐) · 'unknown'(플래그는 없지만 조직이 원격 설정을 내려보내는데 캐시를 볼 수 없음) · 'clear'
 * @returns {{ status, flags: {key, value:'<on>', source}[], sources: {name, path, present, parseError}[], remoteManaged, checkedAt }}
 */
export function scanTelemetry({ env = process.env, configDir, managedFile = DEFAULT_MANAGED_FILE, doctorOutput = null, now = Date.now } = {}) {
  const dir = configDir ? String(configDir) : path.join(process.env.HOME || '', '.claude');
  const files = [
    { name: REMOTE_CACHE_FILE, path: path.join(dir, REMOTE_CACHE_FILE) },
    { name: 'managed-settings.json', path: String(managedFile || DEFAULT_MANAGED_FILE) },
    { name: USER_SETTINGS_FILE, path: path.join(dir, USER_SETTINGS_FILE) },
  ];
  const flags = [];
  const sources = [];
  for (const f of files) {
    const r = readSettingsFile(f.path);
    sources.push({ name: f.name, path: f.path, present: r.present, parseError: r.parseError });
    if (r.json) flags.push(...flagsFromJson(r.json, f.name));
  }
  const e = env && typeof env === 'object' ? env : {};
  for (const key of CONTENT_FLAGS) if (isFlagOn(e[key])) flags.push({ key, value: '<on>', source: 'process env' });
  sources.push({ name: 'process env', path: null, present: true, parseError: false });

  const remoteManaged = parseRemoteManaged(doctorOutput);
  const remote = sources[0];
  let status = 'clear';
  if (flags.length) status = 'blocked';
  else if (remoteManaged === 'loaded' && (!remote.present || remote.parseError)) status = 'unknown';
  return { status, flags, sources, remoteManaged, checkedAt: now() };
}

/** 가드 방식과 상태로 Claude 호출을 거부할지 */
export function shouldRefuse(mode, status) {
  const m = parseGuardMode(mode);
  if (m === 'block') return status === 'blocked';
  if (m === 'strict') return status === 'blocked' || status === 'unknown';
  return false;
}

/** 플래그 목록 → 중복 없는 키 배열 (health·오류 응답에 넣는 형태) */
export function flagKeys(flags) {
  return [...new Set((flags ?? []).map((f) => f.key))];
}

/**
 * 서버가 들고 있는 가드 상태 머신: 시작 시 검사, 주기적 재검사, 설정 파일 변경 감시(2초 디바운스).
 * runDoctor(): `claude doctor` 출력 문자열(또는 null)을 돌려주는 비동기 함수 — 서버가 CLI 실행 경로를 넘긴다.
 */
export function createTelemetryGuard({
  mode = 'block', configDir, managedFile = DEFAULT_MANAGED_FILE, recheckMs = 3600000, env = process.env,
  runDoctor = async () => null, log = null, now = Date.now, debounceMs = 2000,
} = {}) {
  const m = parseGuardMode(mode);
  const state = { mode: m, status: m === 'off' ? null : 'unknown', flags: [], remoteManaged: 'unknown', checkedAt: 0, cacheFile: 'absent', sources: [] };
  let timer = null;
  let watcher = null;
  let debounce = null;
  let running = null;
  let again = null; // 검사 중에 들어온 재검사 요청 (끝나면 한 번 더)
  let stopped = false;
  let firstDone = false;
  let lastDoctor = null; // 마지막으로 읽은(원격 관리 줄이 있는) `claude doctor` 출력 — 파일 변경 재검사는 CLI 를 다시 띄우지 않고 이것을 쓴다

  function describe(scan) {
    const parts = [];
    for (const f of scan.flags) parts.push(`${f.key}@${f.source}`);
    return parts.length ? ` (${[...new Set(parts)].join(', ')})` : '';
  }

  async function scanOnce(reason, doctor) {
    if (doctor) {
      // doctor 가 실패·시간 초과·엉뚱한 출력이면 마지막으로 읽은 결과를 그대로 둔다 — 한 번의 실행 오류로
      // 'loaded' 가 'unknown' 으로 바뀌어 strict 차단이 풀리지 않게(실패 시 열리지 않게) 한다.
      let out = null;
      try { out = await runDoctor(); } catch (err) { out = null; log?.warn?.('claude doctor 실행 실패', err?.message); }
      if (typeof out === 'string' && DOCTOR_REMOTE_RE.test(out)) lastDoctor = out;
      else log?.warn?.(`claude doctor 결과를 읽지 못해 이전 결과를 유지합니다 (원격관리=${parseRemoteManaged(lastDoctor)})`);
    }
    const scan = scanTelemetry({ env, configDir, managedFile, doctorOutput: lastDoctor, now });
    const prev = state.status;
    Object.assign(state, {
      status: scan.status,
      flags: flagKeys(scan.flags),
      remoteManaged: scan.remoteManaged,
      checkedAt: scan.checkedAt,
      cacheFile: scan.sources[0]?.present ? 'present' : 'absent',
      sources: scan.sources,
    });
    if (!firstDone || prev !== scan.status) {
      firstDone = true;
      // 값·경로는 남기지 않는다 (키 이름과 출처 파일 이름만)
      const line = `텔레메트리 가드[${m}]: ${prev ?? '-'} → ${scan.status}${describe(scan)} 원격관리=${scan.remoteManaged} 캐시=${state.cacheFile}${reason ? ` [${reason}]` : ''}`;
      if (scan.status === 'blocked') log?.warn?.(line); else log?.info?.(line);
    }
    return state;
  }

  /**
   * 다시 검사한다. doctor:false 면 마지막 doctor 출력을 재사용한다(파일 변경 때).
   * 이미 검사 중이면 끝난 뒤 한 번 더 검사해, 검사 도중의 파일 변경을 놓치지 않는다.
   */
  function rescan(reason = '', { doctor = true } = {}) {
    if (m === 'off' || stopped) return Promise.resolve(state);
    if (running) {
      again = { reason, doctor: doctor || (again?.doctor ?? false) };
      return running;
    }
    running = (async () => {
      let job = { reason, doctor };
      while (job && !stopped) {
        await scanOnce(job.reason, job.doctor);
        job = again;
        again = null;
      }
      return state;
    })().finally(() => { running = null; });
    return running;
  }

  /** 감시 대상: remote-settings.json · settings.json (원자적 쓰기의 임시 파일 이름도 포함, 이름을 모르면 일단 검사) */
  function isWatchedName(filename) {
    const name = filename == null ? '' : String(filename);
    return !name || name.includes(REMOTE_CACHE_FILE) || name.includes(USER_SETTINGS_FILE);
  }

  function onFileEvent(filename) {
    if (!isWatchedName(filename)) return;
    clearTimeout(debounce);
    debounce = setTimeout(() => { rescan('설정 파일 변경', { doctor: false }).catch(() => {}); }, debounceMs);
    debounce.unref?.();
  }

  /** 설정 폴더 감시 시작 (폴더가 없거나 실패하면 조용히 넘어가고 다음 주기 검사 때 다시 시도) */
  function watch() {
    if (watcher || stopped || !configDir) return;
    try {
      watcher = fs.watch(configDir, { persistent: false }, (_ev, filename) => onFileEvent(filename));
      watcher.on('error', () => { try { watcher?.close(); } catch { /* 무시 */ } watcher = null; });
      watcher.unref?.();
    } catch {
      watcher = null;
    }
  }

  /** 감시를 먼저 걸고(첫 검사 도중의 변경도 잡도록) 첫 검사를 끝낸 뒤 주기 재검사를 예약한다 */
  async function start() {
    if (m === 'off' || stopped) return state;
    watch();
    await rescan('시작');
    if (stopped) return state;
    timer = setInterval(() => { watch(); rescan('주기 재검사').catch(() => {}); }, Math.max(1000, Number(recheckMs) || 3600000));
    timer.unref();
    return state;
  }

  function stop() {
    stopped = true;
    clearInterval(timer);
    clearTimeout(debounce);
    try { watcher?.close(); } catch { /* 무시 */ }
    watcher = null;
  }

  /** 지금 상태로 Claude 호출을 거부해야 하는지 */
  function refuse() {
    return m !== 'off' && shouldRefuse(m, state.status);
  }

  /** health 에 넣는 형태 — 값·운영자 홈 경로는 절대 넣지 않는다. off 면 null. */
  function health() {
    if (m === 'off') return null;
    return { mode: m, status: state.status, flags: [...state.flags], remoteManaged: state.remoteManaged, checkedAt: state.checkedAt, cacheFile: state.cacheFile };
  }

  return { state, start, stop, rescan, refuse, health, get mode() { return m; } };
}
