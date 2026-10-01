// 자소서 에이전트 UI 컨트롤러 (프레임워크 없이 상태 → HTML 렌더링)
import { MODELS, EFFORTS, TIERS, describeError, costFromMessage } from './api.js';
import { createAgent, DEFAULT_SETTINGS, emptyInterview, ensureAnswer, currentText, currentVersion, upsertExperience, addVersion } from './agent.js';
import { createSdkClient } from './llm-sdk.js';
import { createSampleProvider } from './llm-sample.js';
import { createRemoteSample } from './llm-remote.js';
import { storage } from './storage.js';
import { COMMON_QUESTIONS, COMPANY_PRESETS } from './presets.js';
import { QUESTION_TYPES, EDIT_PRESETS, SCORE_LABELS, INTERVIEW_SKIP_ANSWER, CRITIQUE_SCHEMA, computeTotal } from './prompts.js';
import { COUNT_MODES, judgeLength, countBy, uid, validateSchema } from './text.js';

// ───────────────────────────── 상태 ─────────────────────────────

function newProject() {
  return {
    id: uid('p'),
    createdAt: Date.now(),
    step: 'setup',
    profile: { company: '', role: '', level: 'new', jobPosting: '', background: '', companyFacts: '', notes: '', jdSummary: null, blind: false },
    questions: [],
    experiences: [],
    interview: emptyInterview(),
    answers: {},
    prep: null,
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, calls: 0, costUsd: 0 },
  };
}

const SAFE_ID = /^[A-Za-z0-9_-]{1,40}$/;
const safeId = (prefix, id) => (typeof id === 'string' && SAFE_ID.test(id) ? id : uid(prefix));
const str = (v) => (typeof v === 'string' ? v : v == null ? '' : String(v));
const strArr = (v) => (Array.isArray(v) ? v.filter((x) => typeof x === 'string') : []);

/** 가져온 첨삭 결과는 스키마 검증을 통과할 때만 유지한다(렌더링에 그대로 쓰이므로) */
function normalizeCritique(c) {
  if (!c || typeof c !== 'object') return null;
  const clean = {
    scores: c.scores && typeof c.scores === 'object' ? c.scores : {},
    total: Number(c.total) || 0,
    needs_revision: !!c.needs_revision,
    must_fix: strArr(c.must_fix),
    issues: Array.isArray(c.issues) ? c.issues.filter((i) => i && typeof i === 'object').map((i) => ({ quote: str(i.quote), why: str(i.why), fix: str(i.fix), severity: ['high', 'medium', 'low'].includes(i.severity) ? i.severity : 'low' })) : [],
    strengths: strArr(c.strengths),
    summary: str(c.summary),
  };
  if (validateSchema(clean, CRITIQUE_SCHEMA).length) return null;
  clean.total = computeTotal(clean.scores);
  if (c.length && typeof c.length === 'object') clean.length = c.length;
  return clean;
}

function normalizeProject(p) {
  const base = newProject();
  if (!p || typeof p !== 'object') return base;
  const out = { ...base, id: safeId('p', p.id), createdAt: Number(p.createdAt) || Date.now(), updatedAt: Number(p.updatedAt) || undefined };
  const prof = p.profile && typeof p.profile === 'object' ? p.profile : {};
  out.profile = {
    company: str(prof.company), role: str(prof.role), level: prof.level === 'exp' ? 'exp' : 'new',
    jobPosting: str(prof.jobPosting), background: str(prof.background), companyFacts: str(prof.companyFacts), notes: str(prof.notes),
    blind: !!prof.blind,
    jdSummary: prof.jdSummary && typeof prof.jdSummary === 'object'
      ? { competencies: strArr(prof.jdSummary.competencies), talent: str(prof.jdSummary.talent), notes: str(prof.jdSummary.notes) }
      : null,
  };
  // 문항 id는 q<번호> 형식만 허용하고 중복을 피한다. 바뀐 id는 답변·경험 카드에도 반영한다.
  const idMap = {};
  const used = new Set();
  const rawQuestions = (Array.isArray(p.questions) ? p.questions : []).filter((q) => q && typeof q === 'object');
  let maxNum = rawQuestions.reduce((m, q) => (typeof q.id === 'string' && /^q\d{1,4}$/.test(q.id) ? Math.max(m, Number(q.id.slice(1))) : m), 0);
  out.questions = rawQuestions.map((q) => {
    let id = typeof q.id === 'string' && /^q\d{1,4}$/.test(q.id) && !used.has(q.id) ? q.id : `q${++maxNum}`;
    used.add(id);
    if (typeof q.id === 'string') idMap[q.id] = id;
    return { id, text: str(q.text), limit: Math.max(0, Number(q.limit) || 0), mode: Object.hasOwn(COUNT_MODES, q.mode) ? q.mode : 'with', type: QUESTION_TYPES.some((t) => t.id === q.type) ? q.type : 'competency' };
  });
  const remapQ = (x) => idMap[x] ?? x;
  out.experiences = (Array.isArray(p.experiences) ? p.experiences : []).filter((e) => e && typeof e === 'object').map((e) => ({
    id: safeId('exp', e.id),
    title: str(e.title), situation: str(e.situation), task: str(e.task), action: str(e.action), result: str(e.result), learned: str(e.learned),
    keywords: strArr(e.keywords),
    questionIds: strArr(e.questionIds).map(remapQ).filter((x) => out.questions.some((q) => q.id === x)),
    source: e.source === 'manual' ? 'manual' : 'interview',
    createdAt: Number(e.createdAt) || Date.now(), updatedAt: Number(e.updatedAt) || Date.now(),
  }));
  const iv = p.interview && typeof p.interview === 'object' ? p.interview : {};
  out.interview = {
    ...emptyInterview(),
    status: ['idle', 'waiting', 'done'].includes(iv.status) ? iv.status : iv.status === 'running' ? (iv.pending ? 'waiting' : 'idle') : 'idle',
    messages: Array.isArray(iv.messages) ? iv.messages.filter((m) => m && (m.role === 'user' || m.role === 'assistant') && (typeof m.content === 'string' || Array.isArray(m.content))) : [],
    transcript: Array.isArray(iv.transcript) ? iv.transcript.filter((t) => t && typeof t === 'object').map((t) => ({ role: t.role === 'user' ? 'user' : 'agent', kind: str(t.kind) || 'question', text: str(t.text), why: str(t.why), example: str(t.example) })) : [],
    pending: iv.pending && typeof iv.pending === 'object' && typeof iv.pending.question === 'string'
      ? { toolUseId: typeof iv.pending.toolUseId === 'string' ? iv.pending.toolUseId : null, results: Array.isArray(iv.pending.results) ? iv.pending.results : [], question: iv.pending.question, why: str(iv.pending.why), example: str(iv.pending.example) }
      : null,
    summary: str(iv.summary), writerNotes: str(iv.writerNotes), questionCount: Number(iv.questionCount) || 0,
  };
  if (out.interview.status === 'waiting' && !out.interview.pending && !out.interview.messages.length) out.interview.status = 'idle';
  out.answers = {};
  if (p.answers && typeof p.answers === 'object') {
    for (const [k, a] of Object.entries(p.answers)) {
      const id = remapQ(k);
      if (!out.questions.some((q) => q.id === id) || !a || typeof a !== 'object') continue;
      const versions = (Array.isArray(a.versions) ? a.versions : []).filter((v) => v && typeof v.text === 'string').map((v) => ({
        id: safeId('v', v.id), label: str(v.label) || '버전', text: v.text, createdAt: Number(v.createdAt) || Date.now(), critique: normalizeCritique(v.critique),
      }));
      out.answers[id] = { versions, currentVersionId: versions.some((v) => v.id === a.currentVersionId) ? a.currentVersionId : versions.at(-1)?.id ?? null, status: versions.length ? 'done' : 'idle', error: '' };
    }
  }
  out.prep = p.prep && typeof p.prep === 'object' && Array.isArray(p.prep.questions)
    ? { questions: p.prep.questions.filter((q) => q && typeof q === 'object').map((q) => ({ question: str(q.question), intent: str(q.intent), strategy: str(q.strategy), based_on: str(q.based_on) })) }
    : null;
  const u = p.usage && typeof p.usage === 'object' ? p.usage : {};
  out.usage = { input: Number(u.input) || 0, output: Number(u.output) || 0, cacheRead: Number(u.cacheRead) || 0, cacheWrite: Number(u.cacheWrite) || 0, calls: Number(u.calls) || 0, costUsd: Number(u.costUsd) || 0 };
  out.step = ['setup', 'interview', 'write', 'done'].includes(p.step) ? p.step : 'setup';
  return out;
}

// 실행 환경: claude.ai 아티팩트(보는 사람의 구독) / 운영자 구독 서버(같은 곳의 ../api/) / 일반 웹(API 키)
const IS_ARTIFACT = typeof window !== 'undefined' && !!window.claude && typeof window.claude.use === 'function';
const RUNTIME = {
  artifact: IS_ARTIFACT,
  sample: null, downloads: null, checked: false, sdk: null,
  server: false, serverInfo: null, remote: null,
  checking: !IS_ARTIFACT, // 일반 웹에서는 ../api/health 확인이 끝날 때까지 true
};

const state = {
  project: normalizeProject(storage.loadProject()),
  settings: { ...DEFAULT_SETTINGS, ...storage.loadSettings() },
  apiKey: storage.loadApiKey(),
  persistKey: storage.hasPersistedApiKey(),
  accessKey: storage.loadAccessKey(),
  ui: { busy: null, abort: null, questionStream: '', stageLog: {}, streamingId: null },
};

const $ = (sel, root = document) => root.querySelector(sel);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmtNum = (n) => Number(n || 0).toLocaleString('ko-KR');

function save() {
  state.project.updatedAt = Date.now();
  storage.saveProject(state.project);
}

function toast(message, kind = '') {
  const box = $('#toast');
  const el = document.createElement('div');
  el.className = `toast ${kind}`;
  el.textContent = message;
  box.appendChild(el);
  setTimeout(() => el.remove(), kind === 'bad' ? 6000 : 3200);
}

function onUsage({ message, model }) {
  const u = state.project.usage;
  u.calls += 1;
  if (message) {
    const c = costFromMessage(message, state.settings.model);
    u.input += c.tokens.input; u.output += c.tokens.output; u.cacheRead += c.tokens.cacheRead; u.cacheWrite += c.tokens.cacheWrite;
    u.costUsd += c.usd;
    if (c.fallbackRan) toast(`안전 분류기 거절로 폴백 모델(${message.model})이 응답했습니다.`);
  } else if (model) {
    u.lastTier = model;
  }
  renderSide();
}

async function getAgent() {
  if (RUNTIME.artifact) {
    if (!RUNTIME.sample) throw Object.assign(new Error(RUNTIME.checked ? '이 페이지에서는 Claude를 호출할 수 없습니다. claude.ai 안에서 열어 주세요.' : 'Claude 연결을 확인하는 중입니다. 잠시 후 다시 시도하세요.'), { code: 'norun' });
    const cfg = { ...DEFAULT_SETTINGS, ...state.settings };
    return createAgent({ provider: createSampleProvider({ sample: RUNTIME.sample, cfg, onUsage }), settings: state.settings, onUsage });
  }
  if (RUNTIME.checking) throw Object.assign(new Error('연결을 확인하는 중입니다. 잠시 후 다시 시도하세요.'), { code: 'norun' });
  if (RUNTIME.server) {
    if (RUNTIME.serverInfo?.auth === 'key' && !state.accessKey) throw Object.assign(new Error('접속 키를 먼저 입력하세요.'), { code: 'noaccess' });
    const cfg = { ...DEFAULT_SETTINGS, ...state.settings };
    return createAgent({ provider: createSampleProvider({ sample: RUNTIME.remote, cfg, onUsage }), settings: state.settings, onUsage });
  }
  if (!state.apiKey) throw Object.assign(new Error('API 키를 먼저 설정하세요.'), { code: 'nokey' });
  RUNTIME.sdk = await createSdkClient({ apiKey: state.apiKey, baseURL: state.settings.baseURL });
  return createAgent({ client: RUNTIME.sdk.client, settings: state.settings, isApiError: RUNTIME.sdk.isApiError, isToolJsonError: RUNTIME.sdk.isToolJsonError, onUsage });
}

async function initRuntime() {
  if (RUNTIME.artifact) {
    try {
      RUNTIME.sample = await window.claude.use('sample');
      RUNTIME.downloads = await window.claude.use('downloads');
    } catch (e) { console.error(e); }
    RUNTIME.checked = true;
    render();
    return;
  }
  // 일반 웹: 같은 곳에 운영자 구독 서버가 있는지 확인한다. 없으면(정적 호스팅의 404, 네트워크 오류 등) 지금까지처럼 API 키 모드.
  const info = await probeServer();
  if (info) {
    RUNTIME.server = true;
    RUNTIME.serverInfo = info;
    RUNTIME.remote = createRemoteSample({ getKey: () => state.accessKey });
  }
  RUNTIME.checking = false;
  RUNTIME.checked = true;
  renderChrome();
  render();
  if (!RUNTIME.server && !hasApiKey() && !state.project.questions.length) setTimeout(() => toast('먼저 설정에서 Anthropic API 키를 입력하세요.'), 300);
}

/** GET ../api/health (4초 제한). jaso 서버의 응답이면 그 JSON을, 아니면 null */
async function probeServer() {
  const json = await fetchJsonQuietly(new URL('../api/health', location.href).href, 4000);
  return json && json.service === 'jaso' && json.runtime === 'server' ? json : null;
}

/**
 * JSON을 조용히 가져온다. 프레임에서 받은 4xx 응답은 브라우저가 콘솔에 오류로 찍기 때문에(정적 호스팅에서는 ../api/health가 404)
 * Worker 안에서 fetch한다 — 워커가 받은 응답은 콘솔에 남지 않는다. Worker를 쓸 수 없으면(CSP 등) 프레임에서 직접 요청한다.
 * 실패·시간 초과·JSON이 아닌 응답은 모두 null.
 */
function fetchJsonQuietly(url, timeoutMs) {
  const init = { headers: { Accept: 'application/json' }, cache: 'no-store' };
  const direct = async (signal) => {
    try {
      const res = await fetch(url, { ...init, signal });
      const text = await res.text();
      return res.ok ? JSON.parse(text) : null;
    } catch { return null; }
  };
  return new Promise((resolve) => {
    const ctl = new AbortController();
    let worker = null;
    let blobUrl = '';
    let settled = false;
    const done = (v) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      ctl.abort();
      try { worker?.terminate(); } catch { /* 이미 종료 */ }
      if (blobUrl) URL.revokeObjectURL(blobUrl);
      resolve(v ?? null);
    };
    const timer = setTimeout(() => done(null), timeoutMs);
    try {
      // 본문은 항상 끝까지 읽는다: 읽지 않은 응답은 브라우저가 "로딩 중"으로 남겨 두어 워커를 끝내도 정리되지 않는다(네트워크 유휴 판정이 막힘)
      const src = `self.onmessage = async (e) => { let v = null; try { const r = await fetch(e.data, ${JSON.stringify(init)}); const t = await r.text(); if (r.ok) v = JSON.parse(t); } catch { v = null; } postMessage(v); };`;
      blobUrl = URL.createObjectURL(new Blob([src], { type: 'text/javascript' }));
      worker = new Worker(blobUrl);
      worker.onmessage = (e) => done(e.data);
      worker.onerror = () => direct(ctl.signal).then(done);
      worker.postMessage(url);
    } catch {
      direct(ctl.signal).then(done);
    }
  });
}

/** 작업이 끝난 뒤 서버 상태(로그인·사용량 창)를 가볍게 다시 읽어 사이드바를 갱신한다 (실패는 무시) */
function refreshServerInfo() {
  if (!RUNTIME.server || !RUNTIME.remote) return;
  RUNTIME.remote.health().then((info) => {
    if (info && info.service === 'jaso') { RUNTIME.serverInfo = info; renderSide(); }
  }).catch(() => {});
}

/** 비동기 작업 래퍼: busy 표시, 중단 컨트롤러, 오류 토스트, 저장·렌더 */
async function runTask(label, fn, { rerender = true } = {}) {
  if (state.ui.busy) { toast('이미 작업이 진행 중입니다. 먼저 중단하세요.', 'bad'); return null; }
  state.ui.busy = label;
  state.ui.abort = new AbortController();
  if (rerender) render();
  try {
    return await fn(state.ui.abort.signal);
  } catch (err) {
    if (err?.code === 'nokey') { toast(err.message, 'bad'); openSettings(); }
    else if (err?.code === 'noaccess') { toast(err.message, 'bad'); openSettings({ focus: '#s-accesskey' }); }
    else if (err?.code === 'norun') toast(err.message, 'bad');
    else if (err?.code === 'aborted' || err?.name === 'APIUserAbortError') toast('중단했습니다.');
    else if (err?.name === 'AgentError' && err.code === 'unauthorized') { toast(err.message, 'bad'); openSettings({ focus: '#s-accesskey' }); }
    else { console.error(err); toast(describeError(err, RUNTIME.sdk?.describeError), 'bad'); }
    return null;
  } finally {
    state.ui.busy = null;
    state.ui.abort = null;
    state.ui.streamingId = null;
    save();
    render();
    if (RUNTIME.server) refreshServerInfo();
  }
}

function nextQuestionId() {
  const max = state.project.questions.reduce((m, q) => Math.max(m, Number(String(q.id).replace(/\D/g, '')) || 0), 0);
  return `q${max + 1}`;
}

function addQuestion(tpl = {}) {
  state.project.questions.push({ id: nextQuestionId(), text: tpl.text ?? '', limit: tpl.limit ?? 1000, mode: tpl.mode ?? 'with', type: tpl.type ?? 'competency' });
}

/** 구독으로 호출하는 환경(아티팩트 또는 운영자 서버): 토큰·비용 대신 호출 수·등급을 보여 준다 */
function isSubscription() { return RUNTIME.artifact || RUNTIME.server; }
const subscriptionLabel = () => (RUNTIME.artifact ? 'claude.ai 구독' : '운영자 구독');

/** Claude를 호출할 준비가 됐는지: 아티팩트는 sample 연결, 서버는 접속 키(또는 개방 모드), 일반 웹은 API 키 */
function hasApiKey() {
  if (RUNTIME.artifact) return !!RUNTIME.sample;
  if (RUNTIME.server) return RUNTIME.serverInfo?.auth === 'open' || !!state.accessKey;
  return !!state.apiKey;
}

/** 아티팩트 뷰어는 confirm()을 지원하지 않으므로 페이지 안의 대화상자로 묻는다 */
function askConfirm(message, { ok = '확인', danger = false } = {}) {
  return new Promise((resolve) => {
    const d = $('#confirm-dialog');
    $('#confirm-message').textContent = message;
    const okBtn = $('#confirm-ok');
    okBtn.textContent = ok;
    okBtn.classList.toggle('danger', danger);
    const done = (v) => { d.removeEventListener('close', onClose); resolve(v); };
    const onClose = () => done(d.returnValue === 'ok');
    d.addEventListener('close', onClose);
    d.returnValue = '';
    d.showModal();
  });
}

/** 문항 세트를 통째로 바꿀 때: 답변·문항 연관·인터뷰어 메모는 옛 문항 id에 묶여 있으므로 정리한다 */
function replaceQuestions() {
  const p = state.project;
  p.questions = [];
  p.answers = {};
  p.prep = null;
  for (const e of p.experiences) e.questionIds = [];
  p.interview.writerNotes = '';
}

// ───────────────────────────── 렌더링 ─────────────────────────────

const STEPS = [
  { id: 'setup', label: '지원 정보' },
  { id: 'interview', label: '경험 인터뷰' },
  { id: 'write', label: '작성·첨삭' },
  { id: 'done', label: '완성' },
];

function stepAllowed(id) {
  const p = state.project;
  const hasQ = p.questions.some((q) => q.text.trim());
  if (id === 'setup') return true;
  if (id === 'interview') return hasQ;
  if (id === 'write') return hasQ;
  if (id === 'done') return Object.values(p.answers).some((a) => a.versions?.length);
  return false;
}

function render() {
  renderSteps();
  renderStage();
  renderSide();
}

function renderSteps() {
  const cur = state.project.step;
  const order = STEPS.map((s) => s.id);
  $('#steps').innerHTML = STEPS.map((s, i) => {
    const done = order.indexOf(s.id) < order.indexOf(cur);
    const cls = `step${s.id === cur ? ' active' : ''}${done ? ' done' : ''}`;
    const disabled = !stepAllowed(s.id) || !!state.ui.busy;
    return `<button class="${cls}" data-action="go-step" data-step="${s.id}" ${disabled ? 'disabled' : ''}><span class="n">${done ? '✓' : i + 1}</span>${s.label}</button>`;
  }).join('');
}

function renderStage() {
  const step = state.project.step;
  const stage = $('#stage');
  if (step === 'setup') stage.innerHTML = renderSetup();
  else if (step === 'interview') stage.innerHTML = renderInterview();
  else if (step === 'write') stage.innerHTML = renderWrite();
  else stage.innerHTML = renderDone();
  if (step === 'interview') {
    const chat = $('#chat');
    if (chat) chat.scrollTop = chat.scrollHeight;
    const ta = $('#iv-answer');
    const active = document.activeElement;
    if (ta && !state.ui.busy && (!active || active === document.body || active.id === 'iv-answer')) ta.focus();
  }
  const live = $('#status-live');
  if (live) live.textContent = state.ui.busy ? busyLabel() : '';
}

function keyNotice() {
  if (RUNTIME.checking) return '<div class="notice info"><span class="spinner"></span> 연결을 확인하고 있습니다…</div>';
  if (RUNTIME.server) {
    const parts = [];
    if (!hasApiKey()) parts.push('<div class="notice">이 페이지는 운영자의 Claude 구독으로 동작합니다. 운영자에게 받은 <b>접속 키</b>를 입력하세요. <button class="btn sm" data-action="open-settings">설정에서 키 입력</button></div>');
    if (RUNTIME.serverInfo?.login?.ok === false) parts.push('<div class="notice bad">운영자의 Claude 로그인이 끊겨 있어 지금은 작성할 수 없습니다. 운영자에게 알려 주세요.</div>');
    return parts.join('');
  }
  if (hasApiKey()) return '';
  if (RUNTIME.artifact) {
    return RUNTIME.checked
      ? '<div class="notice bad">이 보기에서는 Claude를 호출할 수 없습니다. claude.ai에 로그인한 상태로 아티팩트를 열어 주세요.</div>'
      : '<div class="notice info"><span class="spinner"></span> Claude 연결을 확인하고 있습니다…</div>';
  }
  return `<div class="notice">아직 API 키가 없습니다. <button class="btn sm" data-action="open-settings">설정에서 키 입력</button> — Anthropic Console에서 발급한 키를 사용하며, 요청은 이 브라우저에서 직접 전송됩니다.</div>`;
}

function qSummary(q) {
  return `${esc(COUNT_MODES[q.mode]?.label ?? '')} ${q.limit ? q.limit + (q.mode === 'bytes2' ? 'byte' : '자') : '제한 없음'}`;
}

function renderSetup() {
  const p = state.project.profile;
  const busy = state.ui.busy;
  const questions = state.project.questions;
  const typeOpts = (sel) => QUESTION_TYPES.map((t) => `<option value="${t.id}" ${t.id === sel ? 'selected' : ''}>${t.label}</option>`).join('');
  const modeOpts = (sel) => Object.entries(COUNT_MODES).map(([k, m]) => `<option value="${k}" ${k === sel ? 'selected' : ''}>${m.label}</option>`).join('');
  const jd = p.jdSummary;
  return `
  <div class="card">
    <div class="card-head"><div><h2>1. 지원 정보</h2><div class="card-title-sub">회사·직무와 자기소개서 문항을 입력하면 에이전트가 경험 인터뷰를 시작합니다.</div></div></div>
    ${keyNotice()}
    <div class="grid-2">
      <div class="field"><label for="f-company">회사명</label><input type="text" id="f-company" data-bind="profile.company" value="${esc(p.company)}" placeholder="예: 네이버"></div>
      <div class="field"><label for="f-role">지원 직무</label><input type="text" id="f-role" data-bind="profile.role" value="${esc(p.role)}" placeholder="예: 백엔드 개발"></div>
    </div>
    <div class="field">
      <label>구분</label>
      <div class="btn-row">
        <label class="check"><input type="radio" name="level" data-bind="profile.level" value="new" ${p.level !== 'exp' ? 'checked' : ''}> 신입</label>
        <label class="check"><input type="radio" name="level" data-bind="profile.level" value="exp" ${p.level === 'exp' ? 'checked' : ''}> 경력</label>
      </div>
    </div>
    <div class="field">
      <label for="f-jd">채용 공고·직무 설명 (선택)</label>
      <textarea id="f-jd" rows="5" data-bind="profile.jobPosting" placeholder="공고 본문을 붙여 넣으면 문항·글자수·요구 역량을 자동으로 뽑아냅니다.">${esc(p.jobPosting)}</textarea>
      <div class="btn-row">
        <button class="btn sm" data-action="analyze-jd" ${busy || !p.jobPosting.trim() ? 'disabled' : ''}>${busy === 'jd' ? '<span class="spinner"></span> 분석 중…' : '공고 분석해서 문항·역량 추출'}</button>
        ${jd ? `<span class="small muted">추출된 핵심 역량: ${jd.competencies.map((c) => `<span class="chip static">${esc(c)}</span>`).join(' ')}</span>` : ''}
      </div>
      ${jd?.notes ? `<div class="notice info small">작성 포인트: ${esc(jd.notes)}</div>` : ''}
    </div>
    <div class="grid-2">
      <div class="field"><label for="f-bg">이력·경력 요약 (선택)</label><textarea id="f-bg" rows="4" data-bind="profile.background" placeholder="학력, 전공, 인턴, 프로젝트, 자격, 경력 등. 인터뷰어가 이걸 보고 질문을 시작합니다.">${esc(p.background)}</textarea></div>
      <div class="field"><label for="f-facts">회사에 대해 아는 것·써 본 서비스·지원 계기 (선택)</label><textarea id="f-facts" rows="4" data-bind="profile.companyFacts" placeholder="지원동기에 쓸 회사 고유 사실. 여기 없는 회사 정보는 AI가 지어내지 않고 생략합니다.">${esc(p.companyFacts ?? '')}</textarea></div>
      <div class="field"><label for="f-notes">강조하고 싶은 점·메모 (선택)</label><textarea id="f-notes" rows="4" data-bind="profile.notes" placeholder="꼭 넣고 싶은 경험, 피하고 싶은 표현, 톤 요청 등">${esc(p.notes)}</textarea></div>
      <div class="field"><label>양식 제약</label><label class="check"><input type="checkbox" data-bind="profile.blind" ${p.blind ? 'checked' : ''}> 블라인드 채용 (공공기관 등 — 학교명·가족·출신지·나이·성별 기재 금지)</label><span class="hint">체크하면 인터뷰·작성·첨삭 모두 해당 정보를 걸러냅니다.</span></div>
    </div>
  </div>

  <div class="card">
    <div class="card-head">
      <div><h2>자기소개서 문항</h2><div class="card-title-sub">문항 문구와 글자수 제한을 공고 그대로 입력하세요. 글자수 기준(공백 포함/제외)이 중요합니다.</div></div>
      <div class="btn-row">
        <select class="input" id="q-template" data-action-change="q-template" style="width:auto">
          <option value="">+ 자주 나오는 문항</option>
          ${COMMON_QUESTIONS.map((q, i) => `<option value="${i}">${esc(q.text.slice(0, 28))}… (${q.limit}자)</option>`).join('')}
        </select>
        <select class="input" id="q-preset" data-action-change="q-preset" style="width:auto">
          <option value="">기업 예시 세트</option>
          ${COMPANY_PRESETS.map((c) => `<option value="${c.id}">${esc(c.name)}</option>`).join('')}
        </select>
        <button class="btn sm" data-action="q-add">+ 빈 문항</button>
      </div>
    </div>
    ${questions.length ? '' : '<div class="empty">문항이 없습니다. 위 메뉴에서 추가하거나 공고를 분석하세요.</div>'}
    ${questions.map((q) => `
      <div class="q-row" data-qid="${q.id}">
        <div class="q-top"><span class="q-id">${q.id}</span><span class="muted small q-summary">${qSummary(q)}</span><span style="flex:1"></span><button class="btn sm ghost danger" data-action="q-remove" data-id="${q.id}">삭제</button></div>
        <textarea data-qbind="text" data-id="${q.id}" rows="2" placeholder="문항 문구">${esc(q.text)}</textarea>
        <div class="q-meta">
          <input type="number" min="0" step="50" class="input" data-qbind="limit" data-id="${q.id}" value="${q.limit ?? 0}" placeholder="글자수 제한 (0=없음)" title="글자수 제한">
          <select class="input" data-qbind="mode" data-id="${q.id}">${modeOpts(q.mode)}</select>
          <select class="input" data-qbind="type" data-id="${q.id}">${typeOpts(q.type)}</select>
        </div>
      </div>`).join('')}
  </div>

  <div class="card">
    <div class="btn-row end">
      <button class="btn" data-action="skip-interview" ${busy ? 'disabled' : ''} title="경험 카드를 직접 입력했다면 인터뷰 없이 바로 작성할 수 있습니다">인터뷰 건너뛰고 작성 →</button>
      <button class="btn primary" data-action="start-interview" ${busy ? 'disabled' : ''}>${state.project.interview.status === 'idle' ? '경험 인터뷰 시작 →' : '인터뷰로 이동 →'}</button>
    </div>
  </div>`;
}

function renderInterview() {
  const iv = state.project.interview;
  const busy = state.ui.busy;
  const transcript = iv.transcript.map((m) => {
    if (m.role === 'user') return `<div class="msg user">${esc(m.text)}</div>`;
    if (m.kind === 'summary') return `<div class="msg note">인터뷰 요약: ${esc(m.text)}</div>`;
    return `<div class="msg agent">${esc(m.text)}${m.why ? `<span class="why">왜 묻나요: ${esc(m.why)}</span>` : ''}${m.example ? `<span class="example">힌트: ${esc(m.example)}</span>` : ''}</div>`;
  }).join('');
  const streaming = busy === 'interview'
    ? `<div class="msg agent streaming">${esc(state.ui.questionStream || '질문을 준비하고 있어요…')}</div>`
    : '';
  const coverage = state.project.questions.map((q) => ({ q, n: state.project.experiences.filter((e) => e.questionIds?.includes(q.id)).length }));
  let footer = '';
  if (iv.status === 'idle') {
    const resumable = iv.messages.length > 0;
    footer = `<div class="btn-row end">${resumable ? `<span class="small muted">인터뷰가 중단됐습니다. 이어서 진행할 수 있습니다.</span><button class="btn ghost danger" data-action="iv-restart" ${busy ? 'disabled' : ''}>처음부터</button>` : ''}<button class="btn primary" data-action="start-interview" ${busy ? 'disabled' : ''}>${resumable ? '이어서 진행' : '인터뷰 시작'}</button></div>`;
  } else if (iv.status === 'done') {
    footer = `
      <div class="notice ok">인터뷰가 끝났습니다. 경험 카드 ${state.project.experiences.length}개가 준비됐습니다.</div>
      ${iv.writerNotes ? `<div class="small muted" style="white-space:pre-wrap">작성 메모: ${esc(iv.writerNotes)}</div>` : ''}
      <div class="btn-row end" style="margin-top:.6rem">
        <button class="btn ghost danger" data-action="iv-restart" ${busy ? 'disabled' : ''}>인터뷰 다시 하기</button>
        <button class="btn primary" data-action="go-write">작성 단계로 →</button>
      </div>`;
  } else {
    footer = `
      <div class="answer-box">
        <div class="field">
          <label for="iv-answer">답변 <span class="muted">(<span class="kbd">Ctrl</span>+<span class="kbd">Enter</span>로 보내기)</span></label>
          <textarea id="iv-answer" rows="4" placeholder="기억나는 대로 편하게 적어 주세요. 숫자·기간·역할이 들어가면 좋습니다." ${busy ? 'disabled' : ''}></textarea>
        </div>
        <div class="btn-row">
          <button class="btn primary" data-action="iv-send" ${busy || iv.status !== 'waiting' ? 'disabled' : ''}>답변 보내기</button>
          <button class="btn" data-action="iv-skip" ${busy || iv.status !== 'waiting' ? 'disabled' : ''}>이 질문 넘어가기</button>
          <span style="flex:1"></span>
          ${busy ? `<button class="btn" data-action="stop">중단</button>` : `<button class="btn" data-action="iv-finish" ${iv.status !== 'waiting' ? 'disabled' : ''}>충분해요, 인터뷰 마치기</button>`}
        </div>
      </div>`;
  }
  return `
  <div class="card">
    <div class="card-head">
      <div><h2>2. 경험 인터뷰</h2><div class="card-title-sub">에이전트가 문항에 맞는 경험을 하나씩 물어보고, 경험 카드로 정리합니다. 질문 ${iv.questionCount}개째</div></div>
      <div class="coverage">${coverage.map((c) => `<div class="c"><span>${c.q.id}</span><span class="${c.n ? 'ok' : 'muted'}">카드 ${c.n}</span></div>`).join('')}</div>
    </div>
    ${keyNotice()}
    <div class="chat" id="chat">${transcript || '<div class="empty">인터뷰를 시작하면 여기에 대화가 표시됩니다.</div>'}${streaming}</div>
    ${footer}
  </div>`;
}

function statusPill(ans, qid) {
  const log = state.ui.stageLog[qid];
  if (state.ui.busy && log) return `<span class="pill busy"><span class="spinner"></span> ${esc(log)}</span>`;
  if (!ans || !ans.versions?.length) return ans?.status === 'error' ? `<span class="pill bad">오류</span>` : `<span class="pill">대기</span>`;
  const v = currentVersion(ans);
  const t = v?.critique?.total;
  if (typeof t === 'number') return `<span class="pill ${t >= 80 ? 'ok' : t >= 65 ? 'warn' : 'bad'}">첨삭 ${t}점</span>`;
  return `<span class="pill ok">작성됨</span>`;
}

function countHtml(q, text) {
  const j = judgeLength(text, q.limit, q.mode);
  const unit = COUNT_MODES[q.mode]?.unit ?? '자';
  const pct = j.max ? Math.min(100, Math.round((j.count / j.max) * 100)) : 0;
  const other = q.mode === 'with' ? `공백 제외 ${fmtNum(countBy('without', text))}자` : `공백 포함 ${fmtNum(countBy('with', text))}자`;
  const label = j.status === 'over' ? `${j.diff}${unit} 초과` : j.status === 'under' ? `${-j.diff}${unit} 부족` : j.status === 'ok' ? '범위 내' : '';
  return `<div class="count ${j.status}"><span><b>${fmtNum(j.count)}${unit}</b> ${j.max ? `/ ${fmtNum(j.max)}${unit} (${esc(COUNT_MODES[q.mode]?.label)})` : `(${esc(COUNT_MODES[q.mode]?.label)}, 제한 없음)`} · ${other}</span>${j.max ? `<div class="bar ${j.status}"><i style="width:${pct}%"></i></div><span>${label}</span>` : ''}</div>`;
}

function critiqueHtml(c) {
  if (!c) return '';
  const dots = (n) => `<span class="dots">${[1, 2, 3, 4, 5].map((i) => `<span class="${i <= n ? 'on' : ''}">●</span>`).join('')}</span>`;
  return `
  <div class="critique">
    <div class="card-head" style="margin-bottom:.2rem"><div><div class="total">${Number(c.total) || 0}<span class="small muted">/100</span></div><div class="small muted">${esc(c.summary)}</div></div>${c.needs_revision ? '<span class="pill warn">재작성 권장</span>' : '<span class="pill ok">통과</span>'}</div>
    <div class="scores">${Object.entries(SCORE_LABELS).map(([k, label]) => `<div class="score"><span>${label}</span>${dots(c.scores?.[k] ?? 0)}</div>`).join('')}</div>
    ${c.must_fix?.length ? `<div class="section-title">반드시 수정</div>${c.must_fix.map((m) => `<div class="issue high">${esc(m)}</div>`).join('')}` : ''}
    ${c.issues?.length ? `<div class="section-title">문제 지점</div>${c.issues.map((i) => `<div class="issue ${esc(i.severity)}"><q>${esc(i.quote)}</q> — ${esc(i.why)}<div class="fix">→ ${esc(i.fix)}</div></div>`).join('')}` : ''}
    ${c.strengths?.length ? `<div class="section-title">살릴 강점</div><div class="small">${c.strengths.map((s) => `<span class="chip static">${esc(s)}</span>`).join(' ')}</div>` : ''}
  </div>`;
}

function renderWrite() {
  const p = state.project;
  const busy = state.ui.busy;
  const exps = p.experiences.length;
  const pendingCount = p.questions.filter((q) => !(p.answers[q.id]?.versions?.length)).length;
  return `
  <div class="card">
    <div class="card-head">
      <div><h2>3. 작성·첨삭</h2><div class="card-title-sub">문항마다 초안 → 인사담당자 첨삭 → 수정 → 글자수 조정을 자동으로 돌립니다. ${isSubscription() ? `${subscriptionLabel()}, 작성 등급 ${esc(state.settings.tier ?? 'complex')}` : `모델 ${esc(MODELS.find((m) => m.id === state.settings.model)?.label ?? state.settings.model)}, 품질 ${esc(state.settings.effort)}`}.</div></div>
      <div class="btn-row">
        ${busy ? `<button class="btn" data-action="stop">중단</button>` : `<button class="btn primary" data-action="write-all" ${!p.questions.length ? 'disabled' : ''}>${pendingCount ? `남은 ${pendingCount}문항 완성하기` : '전체 다시 생성'}</button>`}
      </div>
    </div>
    ${keyNotice()}
    ${exps ? '' : '<div class="notice">경험 카드가 없습니다. 인터뷰를 하거나 오른쪽에서 카드를 직접 추가하면 훨씬 구체적인 글이 나옵니다. 지금 생성하면 이력 요약만으로 작성합니다.</div>'}
  </div>
  ${p.questions.map((q) => renderAnswerCard(q)).join('')}
  <div class="card"><div class="btn-row end"><button class="btn primary" data-action="go-done" ${stepAllowed('done') ? '' : 'disabled'}>완성본 보기 →</button></div></div>`;
}

function renderAnswerCard(q) {
  const ans = state.project.answers[q.id];
  const busy = state.ui.busy;
  const text = currentText(ans);
  const v = currentVersion(ans);
  const rowBusy = busy && state.ui.stageLog[q.id];
  const disabled = busy ? 'disabled' : '';
  return `
  <div class="card answer-card" data-qid="${q.id}">
    <div class="card-head">
      <div><h3><span class="q-id" style="color:var(--accent);font-family:ui-monospace,monospace">${q.id}</span> ${esc(q.text)}</h3><div class="card-title-sub">${q.limit ? `제한 ${q.limit}${COUNT_MODES[q.mode]?.unit ?? '자'} (${esc(COUNT_MODES[q.mode]?.label)})` : '글자수 제한 없음'}${q.type ? ` · ${esc(QUESTION_TYPES.find((t) => t.id === q.type)?.label ?? '')}` : ''}</div></div>
      <div class="btn-row">${statusPill(ans, q.id)}
        ${text ? `<button class="btn sm" data-action="regen-one" data-id="${q.id}" ${disabled}>다시 생성</button><button class="btn sm" data-action="alt-one" data-id="${q.id}" ${disabled}>대안 버전</button><button class="btn sm" data-action="critique-one" data-id="${q.id}" ${disabled}>첨삭만</button><button class="btn sm" data-action="copy-one" data-id="${q.id}">복사</button>`
          : `<button class="btn sm primary" data-action="write-one" data-id="${q.id}" ${disabled}>이 문항 작성</button>`}
      </div>
    </div>
    <div class="body">
      ${ans?.versions?.length > 1 ? `<div class="versions"><span class="tiny muted">버전:</span>${ans.versions.map((x) => `<button class="v ${x.id === v?.id ? 'current' : ''}" data-action="version-select" data-id="${q.id}" data-vid="${x.id}" title="${x.critique ? `첨삭 ${Number(x.critique.total) || 0}점` : ''}">${esc(x.label)}</button>`).join('')}</div>` : ''}
      <textarea class="answer-text ${state.ui.streamingId === q.id ? 'streaming' : ''}" data-answer="${q.id}" id="answer-${q.id}" placeholder="${rowBusy ? '' : '아직 작성되지 않았습니다. 「이 문항 작성」을 누르세요.'}" ${busy ? 'readonly' : ''}>${esc(text)}</textarea>
      <div id="count-${q.id}">${countHtml(q, text)}</div>
      ${text ? `
      <div class="btn-row">${EDIT_PRESETS.map((e) => `<button class="chip" data-action="edit-preset" data-id="${q.id}" data-preset="${e.id}" ${disabled}>${esc(e.label)}</button>`).join('')}</div>
      <div class="edit-box">
        <input type="text" class="input" id="edit-input-${q.id}" placeholder="수정 요청 (예: 두 번째 문단을 결과 중심으로, 숫자를 더 앞에) — 본문에서 문장을 드래그하면 그 부분만 고칩니다" ${disabled}>
        <button class="btn" data-action="edit-one" data-id="${q.id}" ${disabled}>수정 요청</button>
      </div>` : ''}
      ${ans?.error ? `<div class="notice bad small">${esc(ans.error)}</div>` : ''}
      ${critiqueHtml(v?.critique)}
    </div>
  </div>`;
}

function renderDone() {
  const p = state.project;
  const busy = state.ui.busy;
  const answers = p.questions.map((q) => ({ q, text: currentText(p.answers[q.id]) })).filter((a) => a.text);
  const warnings = [];
  for (const { q, text } of answers) {
    const j = judgeLength(text, q.limit, q.mode);
    if (j.status === 'over') warnings.push(`${q.id}: ${j.diff}${COUNT_MODES[q.mode]?.unit} 초과`);
    const brackets = text.match(/\[확인[^\]]*\]/g);
    if (brackets) warnings.push(`${q.id}: 확인 필요 항목 ${brackets.length}개 — ${brackets.join(', ')}`);
  }
  const missing = p.questions.filter((q) => !currentText(p.answers[q.id])).map((q) => q.id);
  if (missing.length) warnings.push(`아직 작성되지 않은 문항: ${missing.join(', ')}`);
  return `
  <div class="card">
    <div class="card-head">
      <div><h2>4. 완성</h2><div class="card-title-sub">${esc(p.profile.company)} · ${esc(p.profile.role)} · 문항 ${answers.length}/${p.questions.length}</div></div>
      <div class="btn-row">
        <button class="btn" data-action="copy-all">전체 복사</button>
        <button class="btn" data-action="download-txt">TXT</button>
        <button class="btn" data-action="download-md">Markdown</button>
        <button class="btn" data-action="export-project">JSON</button>
      </div>
    </div>
    ${warnings.length ? `<div class="notice">${warnings.map((w) => `• ${esc(w)}`).join('<br>')}</div>` : '<div class="notice ok">모든 문항이 글자수 범위 안에 있고 확인 필요 항목이 없습니다.</div>'}
  </div>
  ${answers.map(({ q, text }) => `
    <div class="card">
      <div class="card-head"><div><h3>${q.id}. ${esc(q.text)}</h3></div><button class="btn sm" data-action="copy-one" data-id="${q.id}">복사</button></div>
      <div class="final">${esc(text)}</div>
      <div style="margin-top:.4rem">${countHtml(q, text)}</div>
    </div>`).join('')}
  <div class="card">
    <div class="card-head">
      <div><h3>면접 예상 질문</h3><div class="card-title-sub">완성한 자소서와 경험 카드를 근거로 면접관이 물을 법한 질문과 답변 전략을 만듭니다.</div></div>
      ${busy ? `<button class="btn" data-action="stop">중단</button>` : `<button class="btn ${p.prep ? '' : 'primary'}" data-action="prep" ${answers.length ? '' : 'disabled'}>${p.prep ? '다시 생성' : '예상 질문 만들기'}</button>`}
    </div>
    ${busy === 'prep' ? '<div class="stage-log"><span class="spinner"></span> 면접 질문을 만들고 있어요…</div>' : ''}
    ${p.prep?.questions?.length ? p.prep.questions.map((x, i) => `<div class="prep-q"><b>Q${i + 1}. ${esc(x.question)}</b> <span class="tiny muted">(${esc(x.based_on)})</span><div class="intent">의도: ${esc(x.intent)}</div><div>전략: ${esc(x.strategy)}</div></div>`).join('') : ''}
  </div>`;
}

function renderSide() {
  const p = state.project;
  const u = p.usage;
  const busy = state.ui.busy;
  const exps = p.experiences;
  const openIds = new Set([...document.querySelectorAll('#side .exp details[open]')].map((d) => d.dataset.id));
  $('#side').innerHTML = `
  <div class="card">
    <div class="card-head"><h3>경험 카드 <span class="muted small">${exps.length}</span></h3><button class="btn sm" data-action="exp-add" ${busy ? 'disabled' : ''}>+ 직접 추가</button></div>
    ${exps.length ? exps.map((e) => `
      <div class="exp">
        <div class="t"><span>${esc(e.title || '(제목 없음)')}</span><span class="id">${e.questionIds?.length ? e.questionIds.join(',') : '-'}</span></div>
        ${e.keywords?.length ? `<div class="k">${e.keywords.map((k) => esc(k)).join(' · ')}</div>` : ''}
        <details data-id="${e.id}" ${openIds.has(e.id) ? 'open' : ''}><summary>자세히</summary>
          <dl><dt>상황</dt><dd>${esc(e.situation || '-')}</dd><dt>과제</dt><dd>${esc(e.task || '-')}</dd><dt>행동</dt><dd>${esc(e.action || '-')}</dd><dt>결과</dt><dd>${esc(e.result || '-')}</dd><dt>배운 점</dt><dd>${esc(e.learned || '-')}</dd></dl>
          <div class="btn-row" style="margin-top:.4rem"><button class="btn sm" data-action="exp-edit" data-id="${e.id}">편집</button><button class="btn sm ghost danger" data-action="exp-delete" data-id="${e.id}">삭제</button></div>
        </details>
      </div>`).join('') : '<div class="empty">인터뷰를 진행하면 자동으로 쌓입니다. 직접 추가할 수도 있습니다.</div>'}
  </div>
  <div class="card">
    <h3 style="font-size:.95rem;margin-bottom:.4rem">사용량 ${isSubscription() ? `<span class="muted small">(${subscriptionLabel()})</span>` : '<span class="muted small">(추정)</span>'}</h3>
    <div class="usage">
      <span>호출</span><b>${fmtNum(u.calls)}</b>
      ${isSubscription() ? `<span>최근 등급</span><b>${esc((u.lastTier ?? '').replace('claude.ai/', '') || '-')}</b>${usageWindowRows()}` : `
      <span>입력 토큰</span><b>${fmtNum(u.input)}</b>
      <span>캐시 읽기</span><b>${fmtNum(u.cacheRead)}</b>
      <span>출력 토큰</span><b>${fmtNum(u.output)}</b>
      <span>비용</span><b>$${(u.costUsd || 0).toFixed(3)}</b>`}
    </div>
    ${busy ? `<div class="stage-log" style="margin-top:.5rem"><span class="spinner"></span> ${esc(busyLabel())}</div>` : ''}
  </div>`;
  const su = $('#s-usage');
  if (su) su.innerHTML = isSubscription()
    ? `<span>호출</span><b>${fmtNum(u.calls)}</b><span>과금</span><b>${subscriptionLabel()} 사용량</b>`
    : `<span>호출</span><b>${fmtNum(u.calls)}</b><span>입력/출력 토큰</span><b>${fmtNum(u.input)} / ${fmtNum(u.output)}</b><span>비용(추정)</span><b>$${(u.costUsd || 0).toFixed(3)}</b>`;
}

const WINDOW_LABELS = { five_hour: '5시간', seven_day: '주간', weekly: '주간' };
const fmtTime = (ms) => new Date(ms).toLocaleString('ko-KR', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });

/** 서버 모드: 운영자 구독의 사용량 창(5시간 등) 상태 행. health의 usageWindow가 없으면 빈 문자열 */
function usageWindowRows() {
  const w = RUNTIME.server ? RUNTIME.serverInfo?.usageWindow : null;
  if (!w || typeof w !== 'object') return '';
  const status = w.status === 'allowed' ? '정상' : w.status === 'allowed_warning' ? '경고(한도 임박)' : w.status === 'rejected' ? '한도 초과' : esc(String(w.status ?? '-'));
  const type = WINDOW_LABELS[w.type] ?? (w.type ? esc(String(w.type)) : '');
  const reset = Number(w.resetsAt) ? ` · ${fmtTime(Number(w.resetsAt) * 1000)} 초기화` : '';
  return `<span>사용량 창${type ? ` <span class="tiny muted">(${type})</span>` : ''}</span><b>${status}${reset}</b>`;
}

function busyLabel() {
  const b = state.ui.busy;
  if (b === 'interview') return '인터뷰어가 생각 중…';
  if (b === 'jd') return '공고 분석 중…';
  if (b === 'prep') return '면접 질문 생성 중…';
  if (b === 'write') return Object.values(state.ui.stageLog).filter(Boolean).join(' / ') || '작성 중…';
  return '작업 중…';
}

// ───────────────────────────── 동작 ─────────────────────────────

function setBind(path, value) {
  const [a, b] = path.split('.');
  if (a === 'profile') state.project.profile[b] = value;
  save();
}

function validateSetup() {
  const p = state.project;
  const problems = [];
  if (!p.profile.company.trim()) problems.push('회사명');
  if (!p.profile.role.trim()) problems.push('지원 직무');
  p.questions = p.questions.filter((q) => q.text.trim() || q.limit);
  if (!p.questions.some((q) => q.text.trim())) problems.push('문항 1개 이상');
  if (problems.length) { toast(`입력이 필요합니다: ${problems.join(', ')}`, 'bad'); return false; }
  return true;
}

const interviewHandlers = () => ({
  onQuestionDelta: (q) => {
    state.ui.questionStream = q;
    const el = $('#chat .msg.streaming');
    if (el) { el.textContent = q; $('#chat').scrollTop = $('#chat').scrollHeight; }
  },
  onExperience: () => { renderSide(); }, // 저장은 턴이 끝난 뒤 runTask에서(도구 결과 없는 히스토리를 남기지 않기 위해)
});

async function startInterview() {
  if (!validateSetup()) return;
  if (!hasApiKey()) { openSettings(); return; }
  const iv = state.project.interview;
  state.project.step = 'interview';
  if (iv.status !== 'idle') { save(); render(); return; }
  state.ui.questionStream = '';
  const resume = iv.messages.length > 0;
  await runTask('interview', async (signal) => {
    const agent = await getAgent();
    const res = resume
      ? await agent.interviewResume(state.project, { ...interviewHandlers(), signal })
      : await agent.interviewStart(state.project, { ...interviewHandlers(), signal });
    if (res.type === 'done') toast('인터뷰가 끝났습니다. 경험 카드를 확인하세요.', 'ok');
  });
}

async function sendAnswer(text) {
  const iv = state.project.interview;
  if (iv.status !== 'waiting') return;
  state.ui.questionStream = '';
  await runTask('interview', async (signal) => {
    const agent = await getAgent();
    const res = await agent.interviewAnswer(state.project, text, { ...interviewHandlers(), signal });
    if (res.type === 'done') toast('인터뷰가 끝났습니다. 경험 카드를 확인하세요.', 'ok');
  });
}

async function finishInterview() {
  state.ui.questionStream = '';
  await runTask('interview', async (signal) => {
    const agent = await getAgent();
    const res = await agent.interviewFinish(state.project, { ...interviewHandlers(), signal });
    if (res.forced) toast('인터뷰어가 정리를 마치지 못해 강제로 종료했습니다. 경험 카드를 직접 보완해 주세요.');
  });
}

function writeHandlers(q, signal) {
  return {
    signal,
    onStage: (stage, info) => {
      const map = { draft: '초안 작성 중', critique: '첨삭 중', revise: `첨삭 반영 ${info?.round ?? ''}`, length: '글자수 조정 중', edit: '수정 중', alternative: '대안 작성 중', done: '' };
      state.ui.stageLog[q.id] = map[stage] ?? stage;
      if (stage === 'draft' || stage === 'revise' || stage === 'length' || stage === 'edit' || stage === 'alternative') {
        state.ui.streamingId = q.id;
        const ta = $(`#answer-${q.id}`);
        if (ta) { ta.value = ''; ta.classList.add('streaming'); ta.setAttribute('readonly', ''); }
      } else state.ui.streamingId = null;
      renderSide();
      const card = $(`.answer-card[data-qid="${q.id}"] .card-head .btn-row`);
      if (card) card.innerHTML = statusPill(state.project.answers[q.id], q.id);
    },
    onText: (_delta, snapshot) => {
      const ta = $(`#answer-${q.id}`);
      if (ta) { ta.value = snapshot; ta.scrollTop = ta.scrollHeight; }
      const c = $(`#count-${q.id}`);
      if (c) c.innerHTML = countHtml(q, snapshot);
    },
    onVersion: (version) => {
      save();
      // 스트리밍 원문 대신 정리된 버전 텍스트를 보여 준다
      const ta = $(`#answer-${q.id}`);
      if (ta && version?.text != null) ta.value = version.text;
      const c = $(`#count-${q.id}`);
      if (c && version?.text != null) c.innerHTML = countHtml(q, version.text);
    },
  };
}

async function writeQuestions(questions) {
  if (!hasApiKey()) { openSettings(); return; }
  await runTask('write', async (signal) => {
    const agent = await getAgent();
    for (const q of questions) {
      if (signal.aborted) break;
      try {
        await agent.complete(state.project, q, writeHandlers(q, signal));
      } catch (err) {
        if (err?.code === 'aborted' || err?.name === 'APIUserAbortError') throw err;
        // 접속 키·로그인·한도·연결 문제는 다음 문항도 똑같이 실패하므로 묶음 작업을 멈춘다
        if (['unauthorized', 'nologin', 'usage_limit', 'network'].includes(err?.code)) throw err;
        console.error(err);
        toast(`${q.id}: ${describeError(err)}`, 'bad');
      } finally {
        state.ui.stageLog[q.id] = '';
        save();
      }
    }
  });
}

async function runOnAnswer(q, label, fn) {
  if (!hasApiKey()) { openSettings(); return; }
  await runTask('write', async (signal) => {
    const agent = await getAgent();
    try {
      await fn(agent, writeHandlers(q, signal));
    } finally {
      state.ui.stageLog[q.id] = '';
    }
  });
}

function manualEdit(q, text) {
  const ans = ensureAnswer(state.project, q.id);
  const v = currentVersion(ans);
  if (v && v.label === '수동 편집') { v.text = text; v.critique = null; }
  else if (v && v.text === text) return;
  else addVersion(ans, text, '수동 편집');
  ans.status = 'done';
  save();
}

async function copyText(text) {
  try { await navigator.clipboard.writeText(text); toast('복사했습니다.', 'ok'); return; } catch { /* 아래 대체 경로 */ }
  try {
    const ta = document.createElement('textarea');
    ta.value = text; ta.setAttribute('readonly', ''); ta.style.position = 'fixed'; ta.style.left = '-9999px';
    document.body.appendChild(ta); ta.select();
    const ok = document.execCommand('copy');
    ta.remove();
    toast(ok ? '복사했습니다.' : '복사에 실패했습니다. 본문을 직접 선택해 복사해 주세요.', ok ? 'ok' : 'bad');
  } catch { toast('복사에 실패했습니다. 본문을 직접 선택해 복사해 주세요.', 'bad'); }
}

async function download(name, content, type = 'text/plain') {
  if (RUNTIME.artifact) {
    // 아티팩트 뷰어는 페이지가 시작한 다운로드를 막으므로 downloads 기능을 쓰고, 없으면 복사로 대체한다
    if (RUNTIME.downloads) {
      try { await RUNTIME.downloads.save({ filename: name, data: content }); toast('저장했습니다.', 'ok'); }
      catch (e) { if (e?.code !== 'cancelled') { console.error(e); toast('저장이 취소되었거나 실패했습니다. 대신 복사합니다.'); await copyText(content); } }
    } else {
      toast('이 보기에서는 파일 저장이 지원되지 않아 내용을 복사합니다.');
      await copyText(content);
    }
    return;
  }
  const blob = new Blob([content], { type: `${type};charset=utf-8` });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = name; a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function finalText(md = false) {
  const p = state.project;
  const head = `${p.profile.company} ${p.profile.role} 자기소개서`;
  const parts = [md ? `# ${head}` : head, ''];
  for (const q of p.questions) {
    const text = currentText(p.answers[q.id]);
    if (!text) continue;
    const j = judgeLength(text, q.limit, q.mode);
    parts.push(md ? `## ${q.id}. ${q.text}` : `[${q.id}] ${q.text}`);
    parts.push(md ? `_${j.count}${COUNT_MODES[q.mode]?.unit} / 제한 ${q.limit || '없음'} (${COUNT_MODES[q.mode]?.label})_` : `(${j.count}${COUNT_MODES[q.mode]?.unit} / 제한 ${q.limit || '없음'}, ${COUNT_MODES[q.mode]?.label})`);
    parts.push('', text, '');
  }
  return parts.join('\n');
}

function exportProject() {
  const data = JSON.stringify({ version: 1, exportedAt: new Date().toISOString(), project: state.project }, null, 2);
  const name = `jaso-${(state.project.profile.company || 'project').replace(/[^\w가-힣]+/g, '_')}-${new Date().toISOString().slice(0, 10)}.json`;
  download(name, data, 'application/json');
}

async function importProject(file) {
  if (state.ui.busy) { toast('작업 중에는 가져올 수 없습니다. 먼저 중단하세요.', 'bad'); return; }
  const prev = state.project;
  try {
    const text = await file.text();
    const data = JSON.parse(text);
    const project = normalizeProject(data.project ?? data);
    if (!project.questions.length && !project.profile.company) throw new Error('프로젝트 형식이 아닙니다.');
    state.project = project;
    state.ui.stageLog = {};
    try {
      render(); // 렌더링이 성공한 뒤에만 저장한다
    } catch (renderErr) {
      state.project = prev;
      render();
      throw new Error(`화면을 그릴 수 없는 데이터입니다 (${renderErr.message})`);
    }
    save();
    toast('가져왔습니다.', 'ok');
  } catch (err) {
    toast(`가져오기 실패: ${err.message}`, 'bad');
  }
}

// ───────────────────────────── 대화상자 ─────────────────────────────

function currentMode() { return RUNTIME.artifact ? 'artifact' : RUNTIME.server ? 'server' : 'api'; }

function openSettings({ focus = null } = {}) {
  const d = $('#settings-dialog');
  const mode = currentMode();
  // data-mode는 공백으로 구분된 여러 모드를 담을 수 있다 (예: "artifact server")
  for (const el of d.querySelectorAll('[data-mode]')) el.hidden = !el.dataset.mode.split(/\s+/).includes(mode);
  $('#s-tier').innerHTML = TIERS.map((t) => `<option value="${t.id}" ${t.id === (state.settings.tier ?? 'complex') ? 'selected' : ''}>${esc(t.label)}</option>`).join('');
  $('#s-apikey').value = state.apiKey;
  $('#s-accesskey').value = state.accessKey;
  $('#s-persist').checked = state.persistKey;
  $('#s-model').innerHTML = MODELS.map((m) => `<option value="${m.id}" ${m.id === state.settings.model ? 'selected' : ''}>${esc(m.label)} — ${esc(m.note)}</option>`).join('');
  $('#s-effort').innerHTML = EFFORTS.map((e) => `<option value="${e.id}" ${e.id === state.settings.effort ? 'selected' : ''}>${esc(e.label)}</option>`).join('');
  $('#s-subheading').value = state.settings.subheading;
  $('#s-maxrev').value = String(state.settings.maxRevisions ?? 2);
  $('#s-fallbacks').checked = state.settings.fallbacks !== false;
  $('#s-baseurl').value = state.settings.baseURL ?? '';
  renderSide();
  d.showModal();
  if (focus) $(focus)?.focus();
}

function saveSettingsFromForm() {
  const f = $('#settings-form');
  const key = f.apiKey.value.trim();
  state.apiKey = key;
  state.persistKey = f.persistKey.checked;
  storage.saveApiKey(key, state.persistKey);
  if (RUNTIME.server) {
    state.accessKey = f.accessKey.value.trim();
    storage.saveAccessKey(state.accessKey);
  }
  state.settings = {
    ...state.settings,
    model: f.model.value,
    effort: f.effort.value,
    tier: f.tier.value || 'complex',
    subheading: f.subheading.value,
    maxRevisions: Number(f.maxRevisions.value),
    fallbacks: f.fallbacks.checked,
    baseURL: f.baseURL.value.trim(),
  };
  storage.saveSettings(state.settings);
  toast('설정을 저장했습니다.', 'ok');
  render();
}

function openExpDialog(exp = null) {
  const f = $('#exp-form');
  $('#exp-dialog-title').textContent = exp ? '경험 카드 편집' : '경험 카드 추가';
  f.id.value = exp?.id ?? '';
  for (const k of ['title', 'situation', 'task', 'action', 'result', 'learned']) f[k].value = exp?.[k] ?? '';
  f.keywords.value = (exp?.keywords ?? []).join(', ');
  $('#exp-qids').innerHTML = state.project.questions.map((q) => `<label class="check"><input type="checkbox" name="qid" value="${q.id}" ${exp?.questionIds?.includes(q.id) ? 'checked' : ''}> ${q.id}</label>`).join('') || '<span class="tiny muted">문항 없음</span>';
  $('#exp-dialog').showModal();
}

function saveExpFromForm() {
  const f = $('#exp-form');
  const input = {
    id: f.id.value,
    title: f.title.value, situation: f.situation.value, task: f.task.value, action: f.action.value, result: f.result.value, learned: f.learned.value,
    keywords: f.keywords.value.split(',').map((s) => s.trim()).filter(Boolean),
    question_ids: [...f.querySelectorAll('input[name=qid]:checked')].map((c) => c.value),
  };
  upsertExperience(state.project, input, 'manual');
  save();
  renderSide();
  renderStage();
}

// ───────────────────────────── 이벤트 ─────────────────────────────

const actions = {
  'open-settings': () => openSettings(),
  'close-settings': () => $('#settings-dialog').close(),
  'clear-key': () => { state.apiKey = ''; state.persistKey = false; storage.clearApiKey(); $('#s-apikey').value = ''; $('#s-persist').checked = false; toast('키를 삭제했습니다.'); render(); },
  'clear-access-key': () => { state.accessKey = ''; storage.clearAccessKey(); $('#s-accesskey').value = ''; toast('접속 키를 삭제했습니다.'); render(); },
  'open-project-menu': () => $('#project-dialog').showModal(),
  'close-project-menu': () => $('#project-dialog').close(),
  'export-project': () => exportProject(),
  'new-project': async () => {
    if (state.ui.busy) return toast('작업 중에는 초기화할 수 없습니다.', 'bad');
    $('#project-dialog').close();
    if (!(await askConfirm('현재 프로젝트(문항·경험 카드·답변)를 모두 지우고 새로 시작할까요?', { ok: '모두 지우기', danger: true }))) return;
    state.project = newProject(); state.ui.stageLog = {}; save(); render();
  },
  'confirm-ok': () => $('#confirm-dialog').close('ok'),
  'confirm-cancel': () => $('#confirm-dialog').close(''),
  'go-step': (el) => { const s = el.dataset.step; if (stepAllowed(s) && !state.ui.busy) { state.project.step = s; save(); render(); } },
  'q-add': () => { addQuestion(); save(); renderStage(); },
  'q-remove': async (el) => {
    const id = el.dataset.id;
    const hasAnswer = state.project.answers[id]?.versions?.length;
    if (hasAnswer && !(await askConfirm(`${id} 문항의 답변도 함께 삭제됩니다. 계속할까요?`, { ok: '삭제', danger: true }))) return;
    state.project.questions = state.project.questions.filter((q) => q.id !== id);
    delete state.project.answers[id];
    for (const e of state.project.experiences) e.questionIds = (e.questionIds ?? []).filter((x) => x !== id);
    save(); render();
  },
  'analyze-jd': async () => {
    if (!hasApiKey()) return openSettings();
    const res = await runTask('jd', async (signal) => (await getAgent()).analyzeJobPosting(state.project.profile.jobPosting, { signal }), { rerender: true });
    if (!res) return;
    const p = state.project.profile;
    if (!p.company.trim() && res.company) p.company = res.company;
    if (!p.role.trim() && res.role) p.role = res.role;
    if (res.level !== 'unknown') p.level = res.level;
    p.jdSummary = { competencies: res.competencies ?? [], talent: res.talent ?? '', notes: res.notes ?? '' };
    if (res.questions?.length) {
      const replace = !state.project.questions.some((q) => q.text.trim()) || (await askConfirm(`공고에서 문항 ${res.questions.length}개를 찾았습니다. 기존 문항을 이것으로 교체할까요? (취소하면 뒤에 추가합니다)`, { ok: '교체' }));
      if (replace) replaceQuestions();
      for (const q of res.questions) addQuestion({ text: q.text, limit: q.limit || 0, mode: q.mode === 'unknown' ? 'with' : q.mode, type: q.type });
      toast(`문항 ${res.questions.length}개를 ${replace ? '설정' : '추가'}했습니다. 글자수 기준을 확인하세요.`, 'ok');
    } else {
      toast('공고에서 자기소개서 문항을 찾지 못했습니다. 역량 키워드만 반영했습니다.');
    }
    save(); render();
  },
  'start-interview': () => startInterview(),
  'skip-interview': () => { if (!validateSetup()) return; state.project.step = 'write'; save(); render(); },
  'iv-send': () => { const ta = $('#iv-answer'); const text = ta?.value.trim(); if (!text) return toast('답변을 입력해 주세요.', 'bad'); sendAnswer(text); },
  'iv-skip': () => sendAnswer(INTERVIEW_SKIP_ANSWER),
  'iv-finish': () => finishInterview(),
  'iv-restart': async () => { if (!(await askConfirm('인터뷰 대화를 지우고 처음부터 다시 할까요? (경험 카드는 유지됩니다)', { ok: '처음부터', danger: true }))) return; state.project.interview = emptyInterview(); save(); startInterview(); },
  'iv-resume': () => startInterview(),
  'go-write': () => { state.project.step = 'write'; save(); render(); },
  'go-done': () => { state.project.step = 'done'; save(); render(); },
  'stop': () => { state.ui.abort?.abort(); },
  'write-all': async () => {
    const p = state.project;
    const pending = p.questions.filter((q) => !(p.answers[q.id]?.versions?.length));
    const list = pending.length ? pending : p.questions;
    if (!pending.length && !(await askConfirm('모든 문항을 다시 생성할까요? 기존 답변은 버전으로 남습니다.', { ok: '다시 생성' }))) return;
    writeQuestions(list);
  },
  'write-one': (el) => { const q = state.project.questions.find((x) => x.id === el.dataset.id); if (q) writeQuestions([q]); },
  'regen-one': (el) => { const q = state.project.questions.find((x) => x.id === el.dataset.id); if (q) writeQuestions([q]); },
  'alt-one': (el) => { const q = state.project.questions.find((x) => x.id === el.dataset.id); if (q) runOnAnswer(q, 'alt', (agent, h) => agent.alternative(state.project, q, h)); },
  'critique-one': (el) => { const q = state.project.questions.find((x) => x.id === el.dataset.id); if (q) runOnAnswer(q, 'critique', (agent, h) => { h.onStage('critique'); return agent.critiqueAnswer(state.project, q, h); }); },
  'edit-preset': (el) => {
    const q = state.project.questions.find((x) => x.id === el.dataset.id);
    const preset = EDIT_PRESETS.find((e) => e.id === el.dataset.preset);
    if (q && preset) runOnAnswer(q, 'edit', (agent, h) => agent.editAnswer(state.project, q, preset.instruction, h));
  },
  'edit-one': (el) => {
    const q = state.project.questions.find((x) => x.id === el.dataset.id);
    if (!q) return;
    const input = $(`#edit-input-${q.id}`);
    const instruction = input?.value.trim();
    if (!instruction) return toast('수정 요청을 입력해 주세요.', 'bad');
    const ta = $(`#answer-${q.id}`);
    const sel = ta && ta.selectionEnd > ta.selectionStart ? ta.value.slice(ta.selectionStart, ta.selectionEnd).trim() : '';
    if (ta && ta.value !== currentText(state.project.answers[q.id])) manualEdit(q, ta.value);
    runOnAnswer(q, 'edit', (agent, h) => (sel.length >= 4
      ? agent.editSelection(state.project, q, sel, instruction, h)
      : agent.editAnswer(state.project, q, instruction, h)));
  },
  'version-select': (el) => {
    const ans = state.project.answers[el.dataset.id];
    if (!ans) return;
    ans.currentVersionId = el.dataset.vid;
    save(); renderStage();
  },
  'copy-one': (el) => copyText(currentText(state.project.answers[el.dataset.id])),
  'copy-all': () => copyText(finalText(false)),
  'download-txt': () => download(`${state.project.profile.company || '자소서'}_자기소개서.txt`, finalText(false)),
  'download-md': () => download(`${state.project.profile.company || '자소서'}_자기소개서.md`, finalText(true), 'text/markdown'),
  'prep': async () => {
    if (!hasApiKey()) return openSettings();
    const res = await runTask('prep', async (signal) => (await getAgent()).interviewPrep(state.project, { signal }));
    if (res) { state.project.prep = res; save(); render(); }
  },
  'exp-add': () => openExpDialog(null),
  'exp-edit': (el) => openExpDialog(state.project.experiences.find((e) => e.id === el.dataset.id)),
  'exp-delete': async (el) => { if (!(await askConfirm('이 경험 카드를 삭제할까요?', { ok: '삭제', danger: true }))) return; state.project.experiences = state.project.experiences.filter((e) => e.id !== el.dataset.id); save(); renderSide(); },
  'close-exp': () => $('#exp-dialog').close(),
};

document.addEventListener('click', (ev) => {
  const el = ev.target.closest('[data-action]');
  if (!el) return;
  const fn = actions[el.dataset.action];
  if (fn) { ev.preventDefault(); fn(el); }
});

document.addEventListener('change', async (ev) => {
  const el = ev.target;
  if (el.dataset.actionChange === 'q-template') {
    const tpl = el.value === '' ? null : COMMON_QUESTIONS[Number(el.value)];
    if (tpl) { addQuestion(tpl); save(); renderStage(); }
    el.value = '';
  } else if (el.dataset.actionChange === 'q-preset') {
    const preset = COMPANY_PRESETS.find((c) => c.id === el.value);
    if (preset) {
      el.value = '';
      const replace = !state.project.questions.some((q) => q.text.trim()) || (await askConfirm(`「${preset.name}」 문항 ${preset.questions.length}개로 기존 문항을 교체할까요? (취소하면 뒤에 추가)\n${preset.note}`, { ok: '교체' }));
      if (replace) replaceQuestions();
      for (const q of preset.questions) addQuestion(q);
      save(); renderStage();
    }
    el.value = '';
  } else if (el.dataset.bind) {
    setBind(el.dataset.bind, el.type === 'checkbox' ? el.checked : el.value);
  } else if (el.dataset.qbind) {
    const q = state.project.questions.find((x) => x.id === el.dataset.id);
    if (!q) return;
    const k = el.dataset.qbind;
    q[k] = k === 'limit' ? Math.max(0, Number(el.value) || 0) : el.value;
    save();
    // 전체 재렌더는 클릭 중인 버튼을 파괴하므로 요약 문구만 갱신한다
    const summary = el.closest('.q-row')?.querySelector('.q-summary');
    if (summary) summary.innerHTML = qSummary(q);
  } else if (el.id === 'import-file' && el.files?.[0]) {
    importProject(el.files[0]).then(() => { $('#project-dialog').close(); el.value = ''; });
  }
});

document.addEventListener('input', (ev) => {
  const el = ev.target;
  if (el.dataset.bind) {
    if (el.type !== 'checkbox' && el.type !== 'radio') setBind(el.dataset.bind, el.value);
    if (el.dataset.bind === 'profile.jobPosting') {
      const btn = $('button[data-action="analyze-jd"]');
      if (btn) btn.disabled = !!state.ui.busy || !el.value.trim();
    }
    return;
  }
  if (el.dataset.qbind === 'text') { const q = state.project.questions.find((x) => x.id === el.dataset.id); if (q) { q.text = el.value; save(); } return; }
  if (el.dataset.answer) {
    const q = state.project.questions.find((x) => x.id === el.dataset.answer);
    if (!q || state.ui.busy) return;
    manualEdit(q, el.value);
    const c = $(`#count-${q.id}`);
    if (c) c.innerHTML = countHtml(q, el.value);
  }
});

document.addEventListener('keydown', (ev) => {
  if ((ev.ctrlKey || ev.metaKey) && ev.key === 'Enter') {
    if (ev.target.id === 'iv-answer') { ev.preventDefault(); actions['iv-send'](); }
    else if (ev.target.id?.startsWith('edit-input-')) { ev.preventDefault(); actions['edit-one']({ dataset: { id: ev.target.id.replace('edit-input-', '') } }); }
  }
});

$('#settings-form').addEventListener('submit', (ev) => { ev.preventDefault(); saveSettingsFromForm(); $('#settings-dialog').close(); });
$('#exp-form').addEventListener('submit', (ev) => { ev.preventDefault(); saveExpFromForm(); $('#exp-dialog').close(); });
window.addEventListener('beforeunload', (ev) => { if (state.ui.busy) { ev.preventDefault(); ev.returnValue = ''; } });

/** 상단 배지·하단 안내문: 실행 환경이 정해질 때마다 갱신한다 (확인 중에는 배지만 '확인 중…') */
function renderChrome() {
  const badge = $('#runtime-badge');
  if (badge) {
    badge.hidden = false;
    badge.textContent = RUNTIME.artifact ? 'claude.ai 구독' : RUNTIME.checking ? '확인 중…' : RUNTIME.server ? '운영자 구독' : 'API 키';
    badge.classList.toggle('server', RUNTIME.server);
  }
  const footer = $('#site-footer');
  if (footer && !RUNTIME.checking) footer.textContent = RUNTIME.artifact
    ? '개인용 도구입니다. 입력한 내용은 이 브라우저에만 저장되며, Claude 호출은 보는 사람의 claude.ai 구독 사용량으로 이뤄집니다.'
    : RUNTIME.server
      ? '개인용 도구입니다. 입력한 내용은 이 브라우저에 저장되고, Claude 호출은 운영자의 서버를 거쳐 운영자의 claude.ai 구독으로 이뤄집니다. 서버는 내용을 저장하지 않습니다.'
      : '개인용 도구입니다. API 키는 이 브라우저에서 Anthropic API로 직접 전송되며, 이 사이트의 서버로는 아무것도 보내지 않습니다.';
}

// 디버깅·E2E용 최소 노출
window.__jaso = { state, render, actions, runtime: RUNTIME };

renderChrome();
render();
initRuntime();
