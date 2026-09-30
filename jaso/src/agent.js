// 자소서 에이전트 코어: 인터뷰 루프(tool use) + 작성·첨삭·수정 파이프라인
// SDK 클라이언트는 주입받는다(테스트에서는 가짜 클라이언트 사용).

import {
  INTERVIEWER_SYSTEM, INTERVIEW_TOOLS, WRITER_SYSTEM, CRITIC_SYSTEM, CRITIQUE_SCHEMA,
  computeTotal, buildInterviewOpening, buildDraftRequest, buildCritiqueRequest,
  buildReviseRequest, buildLengthFixRequest, buildEditRequest, INTERVIEW_FINISH_REQUEST,
  JD_ANALYST_SYSTEM, JD_SCHEMA, buildJdRequest,
  INTERVIEW_PREP_SYSTEM, INTERVIEW_PREP_SCHEMA, buildInterviewPrepRequest,
  buildAlternativeRequest, buildSelectionEditRequest,
} from './prompts.js';
import { judgeLength, cleanModelText, validateSchema, uid } from './text.js';

/** 서버 측 안전 분류기 폴백(fallbacks: "default")을 지원하는 모델 */
export const FALLBACK_MODELS = new Set(['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-fable-5-1']);

export const DEFAULT_SETTINGS = {
  model: 'claude-opus-5-5',
  effort: 'high', // 작성·수정 단계 effort. 인터뷰·첨삭은 medium 고정
  fallbacks: true,
  baseURL: '',
  subheading: 'auto', // auto | on | off
  maxRevisions: 2,
};

export class AgentError extends Error {
  constructor(code, message, extra = {}) {
    super(message);
    this.name = 'AgentError';
    this.code = code;
    Object.assign(this, extra);
  }
}

const TOOL_SCHEMAS = Object.fromEntries(INTERVIEW_TOOLS.map((t) => [t.name, t.input_schema]));

export function textOf(message) {
  return (message?.content ?? [])
    .filter((b) => b.type === 'text')
    .map((b) => b.text)
    .join('');
}

export function emptyInterview() {
  return { status: 'idle', messages: [], transcript: [], pending: null, summary: '', writerNotes: '', questionCount: 0 };
}

export function ensureAnswer(project, questionId) {
  project.answers ??= {};
  project.answers[questionId] ??= { versions: [], currentVersionId: null, status: 'idle', error: '' };
  return project.answers[questionId];
}

export function currentText(answer) {
  if (!answer?.versions?.length) return '';
  const v = answer.versions.find((x) => x.id === answer.currentVersionId) ?? answer.versions[answer.versions.length - 1];
  return v?.text ?? '';
}

export function currentVersion(answer) {
  if (!answer?.versions?.length) return null;
  return answer.versions.find((x) => x.id === answer.currentVersionId) ?? answer.versions[answer.versions.length - 1];
}

export function addVersion(answer, text, label, extra = {}) {
  const v = { id: uid('v'), label, text, createdAt: Date.now(), critique: null, ...extra };
  answer.versions.push(v);
  answer.currentVersionId = v.id;
  return v;
}

/** 경험 카드 저장/갱신 (인터뷰 도구·수동 입력 공용) */
export function upsertExperience(project, input, source = 'interview') {
  project.experiences ??= [];
  const clean = (s) => (typeof s === 'string' ? s.trim() : '');
  const card = {
    title: clean(input.title),
    situation: clean(input.situation),
    task: clean(input.task),
    action: clean(input.action),
    result: clean(input.result),
    learned: clean(input.learned),
    keywords: Array.isArray(input.keywords) ? input.keywords.map(clean).filter(Boolean) : [],
    questionIds: Array.isArray(input.question_ids ?? input.questionIds)
      ? (input.question_ids ?? input.questionIds).map(clean).filter((id) => project.questions?.some((q) => q.id === id))
      : [],
    source,
  };
  const id = clean(input.id);
  const existing = id ? project.experiences.find((e) => e.id === id) : null;
  if (existing) {
    // 갱신: 새 값이 비어 있으면 기존 값 유지
    for (const k of ['title', 'situation', 'task', 'action', 'result', 'learned']) {
      if (card[k]) existing[k] = card[k];
    }
    if (card.keywords.length) existing.keywords = card.keywords;
    if (card.questionIds.length) existing.questionIds = card.questionIds;
    existing.updatedAt = Date.now();
    return existing;
  }
  const created = { id: uid('exp'), ...card, createdAt: Date.now(), updatedAt: Date.now() };
  project.experiences.push(created);
  return created;
}

function completedAnswers(project, exceptId) {
  return (project.questions ?? [])
    .filter((q) => q.id !== exceptId)
    .map((q) => ({ q, text: currentText(project.answers?.[q.id]) }))
    .filter(({ text }) => text.trim())
    .map(({ q, text }) => ({ id: q.id, questionText: q.text, text }));
}

export function createAgent({ client, settings = {}, onUsage, isApiError = () => false }) {
  const cfg = { ...DEFAULT_SETTINGS, ...settings };
  const eager = !cfg.baseURL; // 프록시 경유 시 eager_input_streaming 생략

  function baseParams({ system, messages, maxTokens = 32000, effort = 'medium', tools, format, autoCache = false }) {
    const params = {
      model: cfg.model,
      max_tokens: maxTokens,
      system: [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }],
      messages,
      output_config: { effort },
    };
    if (autoCache) params.cache_control = { type: 'ephemeral' };
    if (tools) params.tools = tools.map((t) => (eager ? { ...t, eager_input_streaming: true } : { ...t }));
    if (format) params.output_config.format = { type: 'json_schema', schema: format };
    if (cfg.fallbacks !== false && FALLBACK_MODELS.has(cfg.model)) {
      params.betas = ['server-side-fallback-2026-07-01'];
      params.fallbacks = 'default';
    }
    return params;
  }

  async function call(params, handlers = {}) {
    let jsonRetries = 0;
    for (;;) {
      const stream = client.beta.messages.stream(params);
      const onAbort = () => stream.abort();
      handlers.signal?.addEventListener('abort', onAbort, { once: true });
      let currentTool = null;
      if (handlers.onText) stream.on('text', handlers.onText);
      if (handlers.onToolJson) {
        stream.on('streamEvent', (ev) => {
          if (ev.type === 'content_block_start' && ev.content_block?.type === 'tool_use') currentTool = ev.content_block.name;
          if (ev.type === 'content_block_stop') currentTool = null;
        });
        stream.on('inputJson', (_partial, snapshot) => handlers.onToolJson(currentTool, snapshot));
      }
      try {
        const message = await stream.finalMessage();
        onUsage?.({ model: message.model, usage: message.usage, stopReason: message.stop_reason });
        return message;
      } catch (err) {
        if (handlers.signal?.aborted) throw new AgentError('aborted', '중단했습니다.');
        // eager 스트리밍에서 도구 입력 JSON을 해석하지 못한 경우만 재시도 (API 오류는 그대로 전달)
        if (!isApiError(err) && err?.name !== 'APIUserAbortError' && params.tools && jsonRetries++ < 2) continue;
        throw err;
      } finally {
        handlers.signal?.removeEventListener('abort', onAbort);
      }
    }
  }

  function checkStop(message, { toolTurn = false } = {}) {
    if (message.stop_reason === 'refusal') {
      throw new AgentError('refusal', '모델이 이 요청을 거절했습니다. 표현을 바꾸거나 다른 모델을 선택해 보세요.', {
        detail: message.stop_details?.explanation ?? '',
      });
    }
    if (message.stop_reason === 'max_tokens') {
      if (toolTurn) throw new AgentError('max_tokens', '응답이 잘렸습니다(max_tokens). 다시 시도해 주세요.');
      return 'truncated';
    }
    return 'ok';
  }

  // ───────────── 인터뷰 ─────────────

  async function interviewStep(project, handlers = {}) {
    const iv = project.interview;
    for (let guard = 0; guard < 6; guard++) {
      const params = baseParams({
        system: INTERVIEWER_SYSTEM,
        messages: iv.messages,
        effort: 'medium',
        tools: INTERVIEW_TOOLS,
        maxTokens: 16000,
        autoCache: true,
      });
      const message = await call(params, {
        signal: handlers.signal,
        onToolJson: (tool, snapshot) => {
          if (tool === 'ask_user' && snapshot && typeof snapshot.question === 'string') handlers.onQuestionDelta?.(snapshot.question);
        },
      });
      const toolUses = message.content.filter((b) => b.type === 'tool_use');
      checkStop(message, { toolTurn: toolUses.length > 0 });
      iv.messages.push({ role: 'assistant', content: message.content }); // thinking 블록 포함, 그대로 되돌려 보낸다

      if (!toolUses.length) {
        const text = textOf(message).trim();
        if (text) {
          // 도구 없이 텍스트로 물어본 경우: 질문으로 취급
          iv.pending = { toolUseId: null, results: [], question: text, why: '', example: '' };
          iv.transcript.push({ role: 'agent', kind: 'question', text, why: '', example: '' });
          iv.questionCount += 1;
          iv.status = 'waiting';
          return { type: 'question', question: iv.pending };
        }
        iv.messages.push({ role: 'user', content: '도구를 사용하세요. ask_user로 질문하거나 finish_interview로 인터뷰를 마치세요.' });
        continue;
      }

      const results = [];
      let ask = null;
      let finished = null;
      for (const tu of toolUses) {
        const schema = TOOL_SCHEMAS[tu.name];
        const errors = schema ? validateSchema(tu.input, schema) : ['unknown tool'];
        if (errors.length) {
          results.push({
            type: 'tool_result', tool_use_id: tu.id, is_error: true,
            content: JSON.stringify({ INVALID_JSON: JSON.stringify(tu.input ?? null), errors }),
          });
          continue;
        }
        if (tu.name === 'save_experience') {
          const card = upsertExperience(project, tu.input, 'interview');
          results.push({ type: 'tool_result', tool_use_id: tu.id, content: `저장됨: id=${card.id}` });
          handlers.onExperience?.(card);
        } else if (tu.name === 'finish_interview') {
          finished = tu.input;
          results.push({ type: 'tool_result', tool_use_id: tu.id, content: '인터뷰를 종료했습니다.' });
        } else if (tu.name === 'ask_user') {
          if (!ask) ask = { toolUseId: tu.id, ...tu.input };
          else results.push({ type: 'tool_result', tool_use_id: tu.id, content: '(한 턴에 질문은 하나만 할 수 있습니다. 이 질문은 다음 턴에 다시 하세요.)' });
        }
      }

      if (finished) {
        iv.messages.push({ role: 'user', content: results });
        iv.summary = finished.summary ?? '';
        iv.writerNotes = finished.writer_notes ?? '';
        iv.pending = null;
        iv.status = 'done';
        iv.transcript.push({ role: 'agent', kind: 'summary', text: iv.summary });
        return { type: 'done', summary: iv.summary };
      }
      if (ask) {
        iv.pending = { toolUseId: ask.toolUseId, results, question: ask.question, why: ask.why ?? '', example: ask.example ?? '' };
        iv.transcript.push({ role: 'agent', kind: 'question', text: ask.question, why: ask.why ?? '', example: ask.example ?? '' });
        iv.questionCount += 1;
        iv.status = 'waiting';
        return { type: 'question', question: iv.pending };
      }
      // 저장만 한 턴: 결과를 돌려주고 계속
      iv.messages.push({ role: 'user', content: results });
    }
    throw new AgentError('loop', '인터뷰어가 질문 없이 도구 호출만 반복했습니다. 다시 시도해 주세요.');
  }

  /** 인터뷰 턴 실행. 실패·중단 시 status를 idle로 되돌려 interviewResume으로 이어갈 수 있게 한다. */
  async function guardedStep(project, handlers) {
    try {
      return await interviewStep(project, handlers);
    } catch (err) {
      const iv = project.interview;
      if (iv.status === 'running') iv.status = iv.pending ? 'waiting' : 'idle';
      throw err;
    }
  }

  async function interviewStart(project, handlers = {}) {
    project.interview = { ...emptyInterview(), status: 'running', messages: [{ role: 'user', content: buildInterviewOpening(project) }] };
    return guardedStep(project, handlers);
  }

  /** 중단·새로고침 뒤 이어서 진행: 마지막 user 턴에 대한 응답을 다시 요청한다(히스토리는 그대로). */
  async function interviewResume(project, handlers = {}) {
    const iv = project.interview;
    if (iv.status === 'done') return { type: 'done', summary: iv.summary };
    if (iv.pending) { iv.status = 'waiting'; return { type: 'question', question: iv.pending }; }
    if (!iv.messages.length) return interviewStart(project, handlers);
    const last = iv.messages[iv.messages.length - 1];
    if (last.role !== 'user') {
      iv.messages.push({ role: 'user', content: '계속 진행하세요. ask_user로 질문하거나 finish_interview로 인터뷰를 마치세요.' });
    }
    iv.status = 'running';
    return guardedStep(project, handlers);
  }

  function pushUserTurn(iv, text) {
    const p = iv.pending;
    if (p?.toolUseId) {
      iv.messages.push({ role: 'user', content: [...(p.results ?? []), { type: 'tool_result', tool_use_id: p.toolUseId, content: text }] });
    } else if (p && p.results?.length) {
      iv.messages.push({ role: 'user', content: [...p.results, { type: 'text', text }] });
    } else {
      iv.messages.push({ role: 'user', content: text });
    }
    iv.pending = null;
    iv.status = 'running';
  }

  async function interviewAnswer(project, answerText, handlers = {}) {
    const iv = project.interview;
    if (iv.status !== 'waiting') throw new AgentError('state', '지금은 답변을 보낼 수 없습니다.');
    const text = String(answerText ?? '').trim();
    if (!text) throw new AgentError('input', '답변을 입력해 주세요.');
    iv.transcript.push({ role: 'user', kind: 'answer', text });
    pushUserTurn(iv, text);
    return guardedStep(project, handlers);
  }

  async function interviewFinish(project, handlers = {}) {
    const iv = project.interview;
    if (iv.status === 'done') return { type: 'done', summary: iv.summary };
    if (iv.status !== 'waiting') throw new AgentError('state', '에이전트가 응답 중입니다. 잠시 후 다시 시도해 주세요.');
    iv.transcript.push({ role: 'user', kind: 'answer', text: '(인터뷰를 여기서 마칠게요)' });
    pushUserTurn(iv, INTERVIEW_FINISH_REQUEST);
    const res = await guardedStep(project, handlers);
    if (res.type !== 'done') {
      // 모델이 그래도 질문하면 강제 종료
      iv.pending = null;
      iv.status = 'done';
      return { type: 'done', summary: iv.summary, forced: true };
    }
    return res;
  }

  // ───────────── 작성 파이프라인 ─────────────

  async function draft(project, question, handlers = {}) {
    const params = baseParams({
      system: WRITER_SYSTEM,
      messages: [{ role: 'user', content: buildDraftRequest(project, question, { otherAnswers: completedAnswers(project, question.id), subheading: cfg.subheading }) }],
      effort: cfg.effort,
    });
    const message = await call(params, { signal: handlers.signal, onText: handlers.onText });
    checkStop(message);
    return cleanModelText(textOf(message));
  }

  async function critique(project, question, text, handlers = {}) {
    const params = baseParams({
      system: CRITIC_SYSTEM,
      messages: [{ role: 'user', content: buildCritiqueRequest(project, question, text) }],
      effort: 'medium',
      format: CRITIQUE_SCHEMA,
      maxTokens: 16000,
    });
    const message = await call(params, { signal: handlers.signal });
    checkStop(message);
    let parsed;
    try {
      parsed = JSON.parse(textOf(message));
    } catch {
      throw new AgentError('parse', '첨삭 결과(JSON)를 해석하지 못했습니다.');
    }
    const errors = validateSchema(parsed, CRITIQUE_SCHEMA);
    if (errors.length) throw new AgentError('parse', `첨삭 결과 형식 오류: ${errors.slice(0, 3).join(', ')}`);
    parsed.total = computeTotal(parsed.scores);
    const length = judgeLength(text, question.limit, question.mode);
    parsed.length = length;
    // 글자수는 파이프라인이 별도(lengthFix)로 맞추므로 내용 기준으로만 재작성 여부를 정한다
    parsed.needs_revision = parsed.total < 80 || parsed.must_fix.length > 0;
    return parsed;
  }

  async function revise(project, question, text, crit, handlers = {}) {
    const params = baseParams({
      system: WRITER_SYSTEM,
      messages: [{ role: 'user', content: buildReviseRequest(project, question, text, crit, { subheading: cfg.subheading }) }],
      effort: cfg.effort,
    });
    const message = await call(params, { signal: handlers.signal, onText: handlers.onText });
    checkStop(message);
    return cleanModelText(textOf(message));
  }

  async function lengthFix(project, question, text, handlers = {}) {
    const params = baseParams({
      system: WRITER_SYSTEM,
      messages: [{ role: 'user', content: buildLengthFixRequest(project, question, text) }],
      effort: 'medium',
    });
    const message = await call(params, { signal: handlers.signal, onText: handlers.onText });
    checkStop(message);
    return cleanModelText(textOf(message));
  }

  async function edit(project, question, text, instruction, handlers = {}) {
    const params = baseParams({
      system: WRITER_SYSTEM,
      messages: [{ role: 'user', content: buildEditRequest(project, question, text, instruction) }],
      effort: cfg.effort,
    });
    const message = await call(params, { signal: handlers.signal, onText: handlers.onText });
    checkStop(message);
    return cleanModelText(textOf(message));
  }

  async function structured(system, content, schema, { effort = 'medium', signal, label = '결과' } = {}) {
    const params = baseParams({
      system,
      messages: [{ role: 'user', content }],
      effort,
      format: schema,
      maxTokens: 16000,
    });
    const message = await call(params, { signal });
    checkStop(message);
    let parsed;
    try {
      parsed = JSON.parse(textOf(message));
    } catch {
      throw new AgentError('parse', `${label}(JSON)를 해석하지 못했습니다.`);
    }
    const errors = validateSchema(parsed, schema);
    if (errors.length) throw new AgentError('parse', `${label} 형식 오류: ${errors.slice(0, 3).join(', ')}`);
    return parsed;
  }

  /** 채용 공고 텍스트에서 회사·직무·문항·역량 추출 */
  async function analyzeJobPosting(postingText, handlers = {}) {
    const text = String(postingText ?? '').trim();
    if (!text) throw new AgentError('input', '공고 내용을 붙여 넣어 주세요.');
    return structured(JD_ANALYST_SYSTEM, buildJdRequest(text), JD_SCHEMA, { signal: handlers.signal, label: '공고 분석 결과' });
  }

  /** 완성된 자소서 기반 면접 예상 질문 */
  async function interviewPrep(project, handlers = {}) {
    const answers = completedAnswers(project, null);
    if (!answers.length) throw new AgentError('state', '완성된 답변이 없습니다.');
    return structured(INTERVIEW_PREP_SYSTEM, buildInterviewPrepRequest(project, answers), INTERVIEW_PREP_SCHEMA, {
      signal: handlers.signal, label: '면접 예상 질문',
    });
  }

  /** 기존 답변과 다른 각도의 대안 버전 생성 */
  async function alternative(project, question, handlers = {}) {
    const ans = ensureAnswer(project, question.id);
    const existing = currentText(ans);
    if (!existing) throw new AgentError('state', '먼저 답변을 생성하세요.');
    ans.status = 'drafting';
    try {
      handlers.onStage?.('alternative');
      const params = baseParams({
        system: WRITER_SYSTEM,
        messages: [{ role: 'user', content: buildAlternativeRequest(project, question, existing, { otherAnswers: completedAnswers(project, question.id), subheading: cfg.subheading }) }],
        effort: cfg.effort,
      });
      const message = await call(params, { signal: handlers.signal, onText: handlers.onText });
      checkStop(message);
      const version = addVersion(ans, cleanModelText(textOf(message)), '대안 버전');
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
      const params = baseParams({
        system: WRITER_SYSTEM,
        messages: [{ role: 'user', content: buildSelectionEditRequest(project, question, text, selection, instruction) }],
        effort: 'medium',
      });
      const message = await call(params, { signal: handlers.signal, onText: handlers.onText });
      checkStop(message);
      const version = addVersion(ans, cleanModelText(textOf(message)), `부분 수정: ${instruction.slice(0, 16)}`);
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
