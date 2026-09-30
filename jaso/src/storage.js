// localStorage/sessionStorage 저장소 (모든 접근을 try/catch로 감싼다)
const PROJECT_KEY = 'jaso.project.v1';
const SETTINGS_KEY = 'jaso.settings.v1';
const KEY_KEY = 'jaso.apiKey.v1';

function read(store, key) {
  try {
    const raw = store.getItem(key);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}
function write(store, key, value) {
  try {
    if (value === null || value === undefined) store.removeItem(key);
    else store.setItem(key, JSON.stringify(value));
    return true;
  } catch {
    return false;
  }
}

export const storage = {
  loadProject: () => read(localStorage, PROJECT_KEY),
  saveProject: (p) => write(localStorage, PROJECT_KEY, p),
  clearProject: () => write(localStorage, PROJECT_KEY, null),
  loadSettings: () => read(localStorage, SETTINGS_KEY) ?? {},
  saveSettings: (s) => write(localStorage, SETTINGS_KEY, s),
  loadApiKey() {
    return read(sessionStorage, KEY_KEY) ?? read(localStorage, KEY_KEY) ?? '';
  },
  saveApiKey(key, persist) {
    write(sessionStorage, KEY_KEY, key || null);
    write(localStorage, KEY_KEY, persist && key ? key : null);
  },
  clearApiKey() {
    write(sessionStorage, KEY_KEY, null);
    write(localStorage, KEY_KEY, null);
  },
};
