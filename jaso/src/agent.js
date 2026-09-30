// 자소서 에이전트 코어: 인터뷰 상태 관리 + 작성·첨삭·수정 파이프라인.
// LLM 호출은 제공자(provider)에 위임한다: SDK(API 키) 또는 claude.ai 아티팩트(sample).

import {
  WRITER_SYSTEM, CRITIC_SYSTEM, CRITIQUE_SCHEMA, computeTotal,
  buildDraftRequest, buildCritiqueRequest, buildReviseRequest, buildLengthFixRequest, buildEditRequest,
  JD_ANALYST_SYSTEM, JD_SCHEMA, buildJdRequest,
  INTERVIEW_PREP_SYSTEM, INTERVIEW_PREP_SCHEMA, buildInterviewPrepRequest,
  buildAlternativeRequest, buildSelectionEditRequest,
} from './prompts.js';
import { judgeLength, cleanModelText, validateSchema, uid } from './text.js';
import { AgentError, FALLBACK_MODELS } from './errors.js';
import { upsertExperience } from './experiences.js';
import { emptyInterview } from './interview.js';
import { createSdkProvider, textOf, stripPreFallback } from './llm-sdk.js';

export { AgentError, FALLBACK_MODELS, upsertExperience, emptyInterview, textOf, stripPreFallback };

export const DEFAULT_SETTINGS = {
  model: 'claude-opus-5-5',
  effort: 'high', // SDK: 작성·수정 단계 effort (인터뷰·첨삭은 medium 고정)
  tier: 'complex', // claude.ai: 작성·수정 단계 모델 등급 (나머지는 default)
  fallbacks: true,
  baseURL: '',
  subheading: 'auto', // auto | on | off
  maxRevisions: 2,
};

export function ensureAnswer(project, questionId) {
  project.answers ??= {};
  project.answers[questionId] ??= { versions: [], currentVersionId: null, status: 'idle', error: '' };
  return project.answers[questionId];
}

export function currentVersion(answer) {
  if (!answer?.versions?.length) return null;
  return answer.versions.find((x) => x.id === answer.currentVersionId) ?? answer.versions[answer.versions.length - 1];
}

export function currentText(answer) {
  return currentVersion(answer)?.text ?? '';
}

export function addVersion(answer, text, label, extra = {}) {
  const v = { id: uid('v'), label, text, createdAt: Date.now(), critique: null, ...extra };
  answer.versions.push(v);
  answer.currentVersionId = v.id;
  return v;
}

function completedAnswers(project, exceptId) {
  return (project.questions ?? [])
    .filter((q) => q.id !== exceptId)
    .map((q) => ({ q, text: currentText(project.answers?.[q.id]) }))
    .filter(({ text }) => text.trim())
    .map(({ q, text }) => ({ id: q.id, questionText: q.text, text }));
}

/**
 * @param {object} opts
 * @param {object} [opts.provider]  llm-sdk.js / llm-sample.js 제공자
 * @param {object} [opts.client]    provider가 없을 때 SDK 제공자를 만들 클라이언트
 */
export function createAgent({ provider, client, settings = {}, onUsage, isApiError = () => false, isToolJsonError = () => false }) {
  const cfg = { ...DEFAULT_SETTINGS, ...settings };
  const llm = provider ?? createSdkProvider({ client, cfg, onUsage, isApiError, isToolJsonError });
  const writerRole = { role: 'writer', effort: cfg.effort };

  // ───────────── 인터뷰 ─────────────

  /** 인터뷰 턴 실행. 실패·중단 시 status를 재개 가능한 상태로 되돌린다. */
  async function guardedStep(project, handlers) {
    try {
      return await llm.interviewStep(project, handlers);
    } catch (err) {
      const iv = project.interview;
      if (iv.status === 'running') iv.status = iv.pending ? 'waiting' : 'idle';
      throw err;
    }
  }

  async function interviewStart(project, handlers = {}) {
    project.interview = { ...emptyInterview(), status: 'running', messages: llm.openInterview(project) };
    return guardedStep(project, handlers);
  }

  /** 중단·새로고침 뒤 이어서 진행 */
  async function interviewResume(project, handlers = {}) {
    const iv = project.interview;
    if (iv.status === 'done') return { type: 'done', summary: iv.summary };
    if (iv.pending) { iv.status = 'waiting'; return { type: 'question', question: iv.pending }; }
    if (!iv.messages.length) return interviewStart(project, handlers);
    llm.prepareResume(iv);
    iv.status = 'running';
    return guardedStep(project, handlers);
  }

  async function interviewAnswer(project, answerText, handlers = {}) {
    const iv = project.interview;
    if (iv.status !== 'waiting') throw new AgentError('state', '지금은 답변을 보낼 수 없습니다.');
    const text = String(answerText ?? '').trim();
    if (!text) throw new AgentError('input', '답변을 입력해 주세요.');
    iv.transcript.push({ role: 'user', kind: 'answer', text });
    llm.pushUserTurn(iv, text);
    iv.pending = null;
    iv.status = 'running';
    return guardedStep(project, handlers);
  }

  async function interviewFinish(project, handlers = {}) {
    const iv = project.interview;
    if (iv.status === 'done') return { type: 'done', summary: iv.summary };
    if (iv.status !== 'waiting') throw new AgentError('state', '에이전트가 응답 중입니다. 잠시 후 다시 시도해 주세요.');
    iv.transcript.push({ role: 'user', kind: 'answer', text: '(인터뷰를 여기서 마칠게요)' });
    llm.pushUserTurn(iv, llm.finishRequest);
    iv.pending = null;
    iv.status = 'running';
    const res = await guardedStep(project, handlers);
    if (res.type !== 'done') {
      iv.pending = null;
      iv.status = 'done'; // 모델이 그래도 질문하면 강제 종료
      return { type: 'done', summary: iv.summary, forced: true };
    }
    return res;
  }

  // ───────────── 작성 파이프라인 ─────────────

  async function structured(system, user, schema, { role = 'critic', signal, label = '결과' } = {}) {
    const parsed = await llm.json({ system, user, schema, role, effort: 'medium', signal, label });
    const errors = validateSchema(parsed, schema);
    if (errors.length) throw new AgentError('parse', `${label} 형식 오류: ${errors.slice(0, 3).join(', ')}`);
    return parsed;
  }

  async function write(user, handlers = {}, { role = 'writer', effort = cfg.effort } = {}) {
    const out = await llm.text({ system: WRITER_SYSTEM, user, role, effort, onText: handlers.onText, signal: handlers.signal });
    return cleanModelText(out);
  }

  async function draft(project, question, handlers = {}) {
    return write(buildDraftRequest(project, question, { otherAnswers: completedAnswers(project, question.id), subheading: cfg.subheading }), handlers, writerRole);
  }

  async function critique(project, question, text, handlers = {}) {
    const parsed = await structured(CRITIC_SYSTEM, buildCritiqueRequest(project, question, text, { subheading: cfg.subheading }), CRITIQUE_SCHEMA, { signal: handlers.signal, label: '첨삭 결과' });
    parsed.total = computeTotal(parsed.scores);
    parsed.length = judgeLength(text, question.limit, question.mode);
    // 글자수는 파이프라인이 별도(lengthFix)로 맞추므로 내용 기준으로만 재작성 여부를 정한다
    parsed.needs_revision = parsed.total < 80 || parsed.must_fix.length > 0;
    return parsed;
  }

  async function revise(project, question, text, crit, handlers = {}) {
    return write(buildReviseRequest(project, question, text, crit, { subheading: cfg.subheading, otherAnswers: completedAnswers(project, question.id) }), handlers, writerRole);
  }

  async function lengthFix(project, question, text, handlers = {}) {
    return write(buildLengthFixRequest(project, question, text), handlers, { role: 'editor', effort: 'medium' });
  }

  async function edit(project, question, text, instruction, handlers = {}) {
    return write(buildEditRequest(project, question, text, instruction), handlers, writerRole);
  }

  /** 채용 공고 텍스트에서 회사·직무·문항·역량 추출 */
  async function analyzeJobPosting(postingText, handlers = {}) {
    const text = String(postingText ?? '').trim();
    if (!text) throw new AgentError('input', '공고 내용을 붙여 넣어 주세요.');
    return structured(JD_ANALYST_SYSTEM, buildJdRequest(text), JD_SCHEMA, { role: 'analyst', signal: handlers.signal, label: '공고 분석 결과' });
  }

  /** 완성된 자소서 기반 면접 예상 질문 */
  async function interviewPrep(project, handlers = {}) {
    const answers = completedAnswers(project, null);
    if (!answers.length) throw new AgentError('state', '완성된 답변이 없습니다.');
    return structured(INTERVIEW_PREP_SYSTEM, buildInterviewPrepRequest(project, answers), INTERVIEW_PREP_SCHEMA, { role: 'analyst', signal: handlers.signal, label: '면접 예상 질문' });
  }

  /** 기존 답변과 다른 각도의 대안 버전 생성 */
  async function alternative(project, question, handlers = {}) {
    const ans = ensureAnswer(project, question.id);
    const existing = currentText(ans);
    if (!existing) throw new AgentError('state', '먼저 답변을 생성하세요.');
    ans.status = 'drafting';
    try {
      handlers.onStage?.('alternative');
      const out = await write(buildAlternativeRequest(project, question, existing, { otherAnswers: completedAnswers(project, question.id), subheading: cfg.subheading }), handlers, writerRole);
      const version = addVersion(ans, out, '대안 버전');
      handlers.onVersion?.(version);
      ans.status = 'done';
      return version;
    } catch (err) {
      ans.status = 'done';
      throw err;
    }
  }

  /** 선택 구간만 수정 */
  async function editSelection(project, question, selection, instruction, handlers = {}) {
    const ans = ensureAnswer(project, question.id);
    const text = currentText(ans);
    if (!text) throw new AgentError('state', '먼저 답변을 생성하세요.');
    if (!text.includes(selection.trim())) throw new AgentError('input', '선택한 구간이 현재 답변에 없습니다.');
    ans.status = 'revising';
    try {
      handlers.onStage?.('edit');
      const out = await write(buildSelectionEditRequest(project, question, text, selection, instruction), handlers, { role: 'editor', effort: 'medium' });
      const version = addVersion(ans, out, `부분 수정: ${instruction.slice(0, 16)}`);
      handlers.onVersion?.(version);
      ans.status = 'done';
      return version;
    } catch (err) {
      ans.status = 'done';
      throw err;
    }
  }

  /**
   * 한 문항 완성: 초안 → 첨삭 → (수정 → 첨삭)×N → 글자수 조정.
   * handlers.onStage(stage, info), handlers.onText(delta, snapshot), handlers.onVersion(version)
   */
  async function complete(project, question, handlers = {}) {
    const ans = ensureAnswer(project, question.id);
    ans.status = 'drafting';
    ans.error = '';
    try {
      handlers.onStage?.('draft');
      let text = await draft(project, question, handlers);
      let version = addVersion(ans, text, '초안');
      handlers.onVersion?.(version);

      ans.status = 'critiquing';
      handlers.onStage?.('critique');
      let crit = await critique(project, question, text, handlers);
      version.critique = crit;
      handlers.onVersion?.(version);

      let rounds = 0;
      while (crit.needs_revision && rounds < (cfg.maxRevisions ?? 2)) {
        rounds += 1;
        ans.status = 'revising';
        handlers.onStage?.('revise', { round: rounds });
        text = await revise(project, question, text, crit, handlers);
        version = addVersion(ans, text, `첨삭 반영 ${rounds}`);
        handlers.onVersion?.(version);
        ans.status = 'critiquing';
        handlers.onStage?.('critique', { round: rounds });
        crit = await critique(project, question, text, handlers);
        version.critique = crit;
        handlers.onVersion?.(version);
      }

      let lj = judgeLength(text, question.limit, question.mode);
      for (let i = 0; i < 2 && (lj.status === 'over' || lj.status === 'under'); i++) {
        ans.status = 'revising';
        handlers.onStage?.('length', { attempt: i + 1, judge: lj });
        text = await lengthFix(project, question, text, handlers);
        version = addVersion(ans, text, i === 0 ? '글자수 조정' : '글자수 재조정', { critique: crit });
        handlers.onVersion?.(version);
        lj = judgeLength(text, question.limit, question.mode);
        if (lj.status === 'ok') break;
      }
      ans.status = 'done';
      handlers.onStage?.('done', { judge: lj, critique: crit });
      return ans;
    } catch (err) {
      ans.status = ans.versions.length ? 'done' : 'error';
      if (err?.code === 'aborted') { ans.status = ans.versions.length ? 'done' : 'idle'; ans.error = ''; }
      else ans.error = err?.message ?? String(err);
      throw err;
    }
  }

  async function editAnswer(project, question, instruction, handlers = {}) {
    const ans = ensureAnswer(project, question.id);
    const text = currentText(ans);
    if (!text) throw new AgentError('state', '먼저 답변을 생성하세요.');
    ans.status = 'revising';
    try {
      handlers.onStage?.('edit');
      const next = await edit(project, question, text, instruction, handlers);
      const version = addVersion(ans, next, `수정: ${instruction.slice(0, 20)}`);
      handlers.onVersion?.(version);
      ans.status = 'done';
      return version;
    } catch (err) {
      ans.status = 'done';
      throw err;
    }
  }

  async function critiqueAnswer(project, question, handlers = {}) {
    const ans = ensureAnswer(project, question.id);
    const version = currentVersion(ans);
    if (!version) throw new AgentError('state', '먼저 답변을 생성하세요.');
    ans.status = 'critiquing';
    try {
      handlers.onStage?.('critique');
      version.critique = await critique(project, question, version.text, handlers);
      ans.status = 'done';
      return version.critique;
    } catch (err) {
      ans.status = 'done';
      throw err;
    }
  }

  return {
    cfg,
    provider: llm,
    interviewStart,
    interviewResume,
    interviewAnswer,
    interviewFinish,
    draft,
    critique,
    revise,
    lengthFix,
    edit,
    complete,
    editAnswer,
    critiqueAnswer,
    analyzeJobPosting,
    interviewPrep,
    alternative,
    editSelection,
  };
}
