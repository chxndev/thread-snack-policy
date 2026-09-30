// localStorage/sessionStorage 저장소 (모든 접근을 try/catch로 감싼다)
const PROJECT_KEY = 'jaso.project.v1';
const SETTINGS_KEY = 'jaso.settings.v1';
const KEY_KEY = 'jaso.apiKey.v1';

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
};
