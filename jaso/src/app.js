// 자소서 에이전트 UI 컨트롤러 (프레임워크 없이 상태 → HTML 렌더링)
import { createClient, MODELS, EFFORTS, describeError, estimateCost, isApiError } from './api.js';
import { createAgent, DEFAULT_SETTINGS, emptyInterview, ensureAnswer, currentText, currentVersion, upsertExperience, addVersion } from './agent.js';
import { storage } from './storage.js';
import { COMMON_QUESTIONS, COMPANY_PRESETS } from './presets.js';
import { QUESTION_TYPES, EDIT_PRESETS, SCORE_LABELS, INTERVIEW_SKIP_ANSWER } from './prompts.js';
import { COUNT_MODES, judgeLength, countBy, uid } from './text.js';

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

function normalizeProject(p) {
  const base = newProject();
  if (!p || typeof p !== 'object') return base;
  const out = { ...base, ...p };
  out.profile = { ...base.profile, ...(p.profile ?? {}) };
  // 문항 id는 q<번호> 형식만 허용. 바뀐 id는 답변·경험 카드에도 반영한다.
  const idMap = {};
  out.questions = (Array.isArray(p.questions) ? p.questions : []).filter((q) => q && typeof q === 'object').map((q, i) => {
    const id = typeof q.id === 'string' && /^q\d{1,4}$/.test(q.id) ? q.id : `q${i + 1}`;
    idMap[q.id] = id;
    return { id, text: String(q.text ?? ''), limit: Math.max(0, Number(q.limit) || 0), mode: q.mode in COUNT_MODES ? q.mode : 'with', type: typeof q.type === 'string' ? q.type : 'competency' };
  });
  out.experiences = (Array.isArray(p.experiences) ? p.experiences : []).filter((e) => e && typeof e === 'object').map((e) => ({
    ...e, id: safeId('exp', e.id),
    keywords: Array.isArray(e.keywords) ? e.keywords.map(String) : [],
    questionIds: Array.isArray(e.questionIds) ? e.questionIds.map((x) => idMap[x] ?? x).filter((x) => out.questions.some((q) => q.id === x)) : [],
  }));
  out.interview = { ...emptyInterview(), ...(p.interview ?? {}) };
  if (!Array.isArray(out.interview.messages)) out.interview.messages = [];
  if (!Array.isArray(out.interview.transcript)) out.interview.transcript = [];
  if (out.interview.status === 'running') out.interview.status = out.interview.pending ? 'waiting' : 'idle';
  out.answers = {};
  if (p.answers && typeof p.answers === 'object') {
    for (const [k, a] of Object.entries(p.answers)) {
      const id = idMap[k] ?? k;
      if (!out.questions.some((q) => q.id === id) || !a || typeof a !== 'object') continue;
      const versions = (Array.isArray(a.versions) ? a.versions : []).filter((v) => v && typeof v.text === 'string').map((v) => ({ ...v, id: safeId('v', v.id), label: String(v.label ?? '버전') }));
      out.answers[id] = { versions, currentVersionId: versions.some((v) => v.id === a.currentVersionId) ? a.currentVersionId : versions.at(-1)?.id ?? null, status: versions.length ? 'done' : 'idle', error: '' };
    }
  }
  out.usage = { ...base.usage, ...(p.usage ?? {}) };
  if (!['setup', 'interview', 'write', 'done'].includes(out.step)) out.step = 'setup';
  return out;
}

const state = {
  project: normalizeProject(storage.loadProject()),
  settings: { ...DEFAULT_SETTINGS, ...storage.loadSettings() },
  apiKey: storage.loadApiKey(),
  persistKey: (() => { try { return !!localStorage.getItem('jaso.apiKey.v1'); } catch { return false; } })(),
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

function getAgent() {
  if (!state.apiKey) throw Object.assign(new Error('API 키를 먼저 설정하세요.'), { code: 'nokey' });
  const client = createClient({ apiKey: state.apiKey, baseURL: state.settings.baseURL });
  return createAgent({
    client,
    settings: state.settings,
    isApiError,
    onUsage: ({ model, usage }) => {
      const u = state.project.usage;
      const one = {
        input: usage?.input_tokens ?? 0,
        output: usage?.output_tokens ?? 0,
        cacheRead: usage?.cache_read_input_tokens ?? 0,
        cacheWrite: usage?.cache_creation_input_tokens ?? 0,
      };
      u.input += one.input; u.output += one.output; u.cacheRead += one.cacheRead; u.cacheWrite += one.cacheWrite; u.calls += 1;
      u.costUsd += estimateCost(model, one) ?? estimateCost(state.settings.model, one) ?? 0;
      renderSide();
    },
  });
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
    else if (err?.code === 'aborted' || err?.name === 'APIUserAbortError') toast('중단했습니다.');
    else { console.error(err); toast(describeError(err), 'bad'); }
    return null;
  } finally {
    state.ui.busy = null;
    state.ui.abort = null;
    state.ui.streamingId = null;
    save();
    render();
  }
}

function nextQuestionId() {
  const max = state.project.questions.reduce((m, q) => Math.max(m, Number(String(q.id).replace(/\D/g, '')) || 0), 0);
  return `q${max + 1}`;
}

function addQuestion(tpl = {}) {
  state.project.questions.push({ id: nextQuestionId(), text: tpl.text ?? '', limit: tpl.limit ?? 1000, mode: tpl.mode ?? 'with', type: tpl.type ?? 'competency' });
}

function hasApiKey() { return !!state.apiKey; }

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
    if (ta && !state.ui.busy) ta.focus();
  }
}

function keyNotice() {
  if (hasApiKey()) return '';
  return `<div class="notice">아직 API 키가 없습니다. <button class="btn sm" data-action="open-settings">설정에서 키 입력</button> — Anthropic Console에서 발급한 키를 사용하며, 요청은 이 브라우저에서 직접 전송됩니다.</div>`;
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
        <div class="q-top"><span class="q-id">${q.id}</span><span class="muted small">${esc(COUNT_MODES[q.mode]?.label ?? '')} ${q.limit ? q.limit + (q.mode === 'bytes2' ? 'byte' : '자') : '제한 없음'}</span><span style="flex:1"></span><button class="btn sm ghost danger" data-action="q-remove" data-id="${q.id}">삭제</button></div>
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
    <div class="card-head" style="margin-bottom:.2rem"><div><div class="total">${c.total}<span class="small muted">/100</span></div><div class="small muted">${esc(c.summary)}</div></div>${c.needs_revision ? '<span class="pill warn">재작성 권장</span>' : '<span class="pill ok">통과</span>'}</div>
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
      <div><h2>3. 작성·첨삭</h2><div class="card-title-sub">문항마다 초안 → 인사담당자 첨삭 → 수정 → 글자수 조정을 자동으로 돌립니다. 모델 ${esc(MODELS.find((m) => m.id === state.settings.model)?.label ?? state.settings.model)}, 품질 ${esc(state.settings.effort)}.</div></div>
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
      ${ans?.versions?.length > 1 ? `<div class="versions"><span class="tiny muted">버전:</span>${ans.versions.map((x) => `<button class="v ${x.id === v?.id ? 'current' : ''}" data-action="version-select" data-id="${q.id}" data-vid="${x.id}" title="${x.critique ? `첨삭 ${x.critique.total}점` : ''}">${esc(x.label)}</button>`).join('')}</div>` : ''}
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
  $('#side').innerHTML = `
  <div class="card">
    <div class="card-head"><h3>경험 카드 <span class="muted small">${exps.length}</span></h3><button class="btn sm" data-action="exp-add" ${busy ? 'disabled' : ''}>+ 직접 추가</button></div>
    ${exps.length ? exps.map((e) => `
      <div class="exp">
        <div class="t"><span>${esc(e.title || '(제목 없음)')}</span><span class="id">${e.questionIds?.length ? e.questionIds.join(',') : '-'}</span></div>
        ${e.keywords?.length ? `<div class="k">${e.keywords.map((k) => esc(k)).join(' · ')}</div>` : ''}
        <details><summary>자세히</summary>
          <dl><dt>상황</dt><dd>${esc(e.situation || '-')}</dd><dt>과제</dt><dd>${esc(e.task || '-')}</dd><dt>행동</dt><dd>${esc(e.action || '-')}</dd><dt>결과</dt><dd>${esc(e.result || '-')}</dd><dt>배운 점</dt><dd>${esc(e.learned || '-')}</dd></dl>
          <div class="btn-row" style="margin-top:.4rem"><button class="btn sm" data-action="exp-edit" data-id="${e.id}">편집</button><button class="btn sm ghost danger" data-action="exp-delete" data-id="${e.id}">삭제</button></div>
        </details>
      </div>`).join('') : '<div class="empty">인터뷰를 진행하면 자동으로 쌓입니다. 직접 추가할 수도 있습니다.</div>'}
  </div>
  <div class="card">
    <h3 style="font-size:.95rem;margin-bottom:.4rem">사용량 <span class="muted small">(추정)</span></h3>
    <div class="usage">
      <span>호출</span><b>${fmtNum(u.calls)}</b>
      <span>입력 토큰</span><b>${fmtNum(u.input)}</b>
      <span>캐시 읽기</span><b>${fmtNum(u.cacheRead)}</b>
      <span>출력 토큰</span><b>${fmtNum(u.output)}</b>
      <span>비용</span><b>$${(u.costUsd || 0).toFixed(3)}</b>
    </div>
    ${busy ? `<div class="stage-log" style="margin-top:.5rem"><span class="spinner"></span> ${esc(busyLabel())}</div>` : ''}
  </div>`;
  const su = $('#s-usage');
  if (su) su.innerHTML = `<span>호출</span><b>${fmtNum(u.calls)}</b><span>입력/출력 토큰</span><b>${fmtNum(u.input)} / ${fmtNum(u.output)}</b><span>비용(추정)</span><b>$${(u.costUsd || 0).toFixed(3)}</b>`;
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
  onExperience: () => { save(); renderSide(); },
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
    const agent = getAgent();
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
    const agent = getAgent();
    const res = await agent.interviewAnswer(state.project, text, { ...interviewHandlers(), signal });
    if (res.type === 'done') toast('인터뷰가 끝났습니다. 경험 카드를 확인하세요.', 'ok');
  });
}

async function finishInterview() {
  state.ui.questionStream = '';
  await runTask('interview', async (signal) => {
    const agent = getAgent();
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
    const agent = getAgent();
    for (const q of questions) {
      if (signal.aborted) break;
      try {
        await agent.complete(state.project, q, writeHandlers(q, signal));
      } catch (err) {
        if (err?.code === 'aborted' || err?.name === 'APIUserAbortError') throw err;
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
    const agent = getAgent();
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
  try { await navigator.clipboard.writeText(text); toast('복사했습니다.', 'ok'); }
  catch { toast('복사에 실패했습니다. 직접 선택해 복사해 주세요.', 'bad'); }
}

function download(name, content, type = 'text/plain') {
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
  try {
    const text = await file.text();
    const data = JSON.parse(text);
    const project = normalizeProject(data.project ?? data);
    if (!project.questions.length && !project.profile.company) throw new Error('프로젝트 형식이 아닙니다.');
    state.project = project;
    save();
    render();
    toast('가져왔습니다.', 'ok');
  } catch (err) {
    toast(`가져오기 실패: ${err.message}`, 'bad');
  }
}

// ───────────────────────────── 대화상자 ─────────────────────────────

function openSettings() {
  const d = $('#settings-dialog');
  $('#s-apikey').value = state.apiKey;
  $('#s-persist').checked = state.persistKey;
  $('#s-model').innerHTML = MODELS.map((m) => `<option value="${m.id}" ${m.id === state.settings.model ? 'selected' : ''}>${esc(m.label)} — ${esc(m.note)}</option>`).join('');
  $('#s-effort').innerHTML = EFFORTS.map((e) => `<option value="${e.id}" ${e.id === state.settings.effort ? 'selected' : ''}>${esc(e.label)}</option>`).join('');
  $('#s-subheading').value = state.settings.subheading;
  $('#s-maxrev').value = String(state.settings.maxRevisions ?? 2);
  $('#s-fallbacks').checked = state.settings.fallbacks !== false;
  $('#s-baseurl').value = state.settings.baseURL ?? '';
  renderSide();
  d.showModal();
}

function saveSettingsFromForm() {
  const f = $('#settings-form');
  const key = f.apiKey.value.trim();
  state.apiKey = key;
  state.persistKey = f.persistKey.checked;
  storage.saveApiKey(key, state.persistKey);
  state.settings = {
    ...state.settings,
    model: f.model.value,
    effort: f.effort.value,
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
  'open-project-menu': () => $('#project-dialog').showModal(),
  'close-project-menu': () => $('#project-dialog').close(),
  'export-project': () => exportProject(),
  'new-project': () => {
    if (state.ui.busy) return toast('작업 중에는 초기화할 수 없습니다.', 'bad');
    if (!confirm('현재 프로젝트(문항·경험 카드·답변)를 모두 지우고 새로 시작할까요?')) return;
    state.project = newProject(); state.ui.stageLog = {}; save(); $('#project-dialog').close(); render();
  },
  'go-step': (el) => { const s = el.dataset.step; if (stepAllowed(s) && !state.ui.busy) { state.project.step = s; save(); render(); } },
  'q-add': () => { addQuestion(); save(); renderStage(); },
  'q-remove': (el) => {
    const id = el.dataset.id;
    const hasAnswer = state.project.answers[id]?.versions?.length;
    if (hasAnswer && !confirm(`${id} 문항의 답변도 함께 삭제됩니다. 계속할까요?`)) return;
    state.project.questions = state.project.questions.filter((q) => q.id !== id);
    delete state.project.answers[id];
    for (const e of state.project.experiences) e.questionIds = (e.questionIds ?? []).filter((x) => x !== id);
    save(); render();
  },
  'analyze-jd': async () => {
    if (!hasApiKey()) return openSettings();
    const res = await runTask('jd', async (signal) => getAgent().analyzeJobPosting(state.project.profile.jobPosting, { signal }), { rerender: true });
    if (!res) return;
    const p = state.project.profile;
    if (!p.company.trim() && res.company) p.company = res.company;
    if (!p.role.trim() && res.role) p.role = res.role;
    if (res.level !== 'unknown') p.level = res.level;
    p.jdSummary = { competencies: res.competencies ?? [], talent: res.talent ?? '', notes: res.notes ?? '' };
    if (res.questions?.length) {
      const replace = !state.project.questions.some((q) => q.text.trim()) || confirm(`공고에서 문항 ${res.questions.length}개를 찾았습니다. 기존 문항을 이것으로 교체할까요? (취소하면 뒤에 추가합니다)`);
      if (replace) { state.project.questions = []; state.project.answers = {}; }
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
  'iv-restart': () => { if (!confirm('인터뷰 대화를 지우고 처음부터 다시 할까요? (경험 카드는 유지됩니다)')) return; state.project.interview = emptyInterview(); save(); startInterview(); },
  'iv-resume': () => startInterview(),
  'go-write': () => { state.project.step = 'write'; save(); render(); },
  'go-done': () => { state.project.step = 'done'; save(); render(); },
  'stop': () => { state.ui.abort?.abort(); },
  'write-all': () => {
    const p = state.project;
    const pending = p.questions.filter((q) => !(p.answers[q.id]?.versions?.length));
    const list = pending.length ? pending : p.questions;
    if (!pending.length && !confirm('모든 문항을 다시 생성할까요? 기존 답변은 버전으로 남습니다.')) return;
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
    const res = await runTask('prep', async (signal) => getAgent().interviewPrep(state.project, { signal }));
    if (res) { state.project.prep = res; save(); render(); }
  },
  'exp-add': () => openExpDialog(null),
  'exp-edit': (el) => openExpDialog(state.project.experiences.find((e) => e.id === el.dataset.id)),
  'exp-delete': (el) => { if (!confirm('이 경험 카드를 삭제할까요?')) return; state.project.experiences = state.project.experiences.filter((e) => e.id !== el.dataset.id); save(); renderSide(); },
  'close-exp': () => $('#exp-dialog').close(),
};

document.addEventListener('click', (ev) => {
  const el = ev.target.closest('[data-action]');
  if (!el) return;
  const fn = actions[el.dataset.action];
  if (fn) { ev.preventDefault(); fn(el); }
});

document.addEventListener('change', (ev) => {
  const el = ev.target;
  if (el.dataset.actionChange === 'q-template') {
    const tpl = COMMON_QUESTIONS[Number(el.value)];
    if (tpl) { addQuestion(tpl); save(); renderStage(); }
    el.value = '';
  } else if (el.dataset.actionChange === 'q-preset') {
    const preset = COMPANY_PRESETS.find((c) => c.id === el.value);
    if (preset) {
      const replace = !state.project.questions.some((q) => q.text.trim()) || confirm(`「${preset.name}」 문항 ${preset.questions.length}개로 기존 문항을 교체할까요? (취소하면 뒤에 추가)\n${preset.note}`);
      if (replace) { state.project.questions = []; state.project.answers = {}; }
      for (const q of preset.questions) addQuestion(q);
      save(); renderStage();
    }
    el.value = '';
  } else if (el.dataset.bind) {
    setBind(el.dataset.bind, el.type === 'checkbox' ? el.checked : el.value);
    if (el.dataset.bind === 'profile.jobPosting') renderStage();
  } else if (el.dataset.qbind) {
    const q = state.project.questions.find((x) => x.id === el.dataset.id);
    if (!q) return;
    const k = el.dataset.qbind;
    q[k] = k === 'limit' ? Math.max(0, Number(el.value) || 0) : el.value;
    save();
    if (k !== 'text') renderStage();
  } else if (el.id === 'import-file' && el.files?.[0]) {
    importProject(el.files[0]).then(() => { $('#project-dialog').close(); el.value = ''; });
  }
});

document.addEventListener('input', (ev) => {
  const el = ev.target;
  if (el.dataset.bind) { if (el.type !== 'checkbox' && el.type !== 'radio') setBind(el.dataset.bind, el.value); return; }
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

// 디버깅·E2E용 최소 노출
window.__jaso = { state, render, actions };

render();
if (!hasApiKey() && !state.project.questions.length) setTimeout(() => toast('먼저 설정에서 Anthropic API 키를 입력하세요.'), 300);
