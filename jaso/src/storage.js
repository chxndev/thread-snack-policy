// localStorage/sessionStorage 저장소 (모든 접근을 try/catch로 감싼다)
const PROJECT_KEY = 'jaso.project.v1';
const SETTINGS_KEY = 'jaso.settings.v1';
const KEY_KEY = 'jaso.apiKey.v1';
const ACCESS_KEY_KEY = 'jaso.accessKey.v1'; // 운영자 구독 서버의 접속 키 (이 브라우저에만 저장)
const SYNC_KEY = 'jaso.sync.v1'; // 기기 간 동기화 상태 (코드·etag·시각). 암호화 키 자체는 저장하지 않고 코드에서 매번 파생한다

/** 동기화 상태 기본값 */
export const EMPTY_SYNC = Object.freeze({ code: '', id: '', etag: '', lastPushedAt: 0, lastPulledAt: 0, baseUpdatedAt: 0, enabled: false });

// 저장소 접근이 차단된 환경(쿠키 차단, 샌드박스 iframe)에서는 전역 접근 자체가 throw 하므로 try 안에서 얻는다
function getStore(kind) {
  try {
    return kind === 'session' ? window.sessionStorage : window.localStorage;
  } catch {
    return null;
  }
}
function read(kind, key) {
  try {
    const store = getStore(kind);
    const raw = store?.getItem(key);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}
function write(kind, key, value) {
  try {
    const store = getStore(kind);
    if (!store) return false;
    if (value === null || value === undefined) store.removeItem(key);
    else store.setItem(key, JSON.stringify(value));
    return true;
  } catch {
    return false;
  }
}

export const storage = {
  loadProject: () => read('local', PROJECT_KEY),
  saveProject: (p) => write('local', PROJECT_KEY, p),
  clearProject: () => write('local', PROJECT_KEY, null),
  loadSettings: () => read('local', SETTINGS_KEY) ?? {},
  saveSettings: (s) => write('local', SETTINGS_KEY, s),
  loadApiKey() {
    return read('session', KEY_KEY) ?? read('local', KEY_KEY) ?? '';
  },
  hasPersistedApiKey() {
    return !!read('local', KEY_KEY);
  },
  saveApiKey(key, persist) {
    write('session', KEY_KEY, key || null);
    write('local', KEY_KEY, persist && key ? key : null);
  },
  clearApiKey() {
    write('session', KEY_KEY, null);
    write('local', KEY_KEY, null);
  },
  loadAccessKey() {
    const v = read('local', ACCESS_KEY_KEY);
    return typeof v === 'string' ? v : '';
  },
  saveAccessKey(key) {
    write('local', ACCESS_KEY_KEY, key || null);
  },
  clearAccessKey() {
    write('local', ACCESS_KEY_KEY, null);
  },
  /** 저장된 동기화 상태를 기본값과 합쳐 모양을 보장한다 */
  loadSync() {
    const v = read('local', SYNC_KEY);
    const s = v && typeof v === 'object' ? v : {};
    const str = (x) => (typeof x === 'string' ? x : '');
    const num = (x) => (Number.isFinite(Number(x)) && Number(x) > 0 ? Number(x) : 0);
    return { code: str(s.code), id: str(s.id), etag: str(s.etag), lastPushedAt: num(s.lastPushedAt), lastPulledAt: num(s.lastPulledAt), baseUpdatedAt: num(s.baseUpdatedAt), enabled: !!s.enabled && !!s.code };
  },
  saveSync(s) {
    write('local', SYNC_KEY, s);
  },
  clearSync() {
    write('local', SYNC_KEY, null);
  },
};
