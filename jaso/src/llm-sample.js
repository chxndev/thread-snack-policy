// claude.ai 아티팩트 제공자: 보는 사람의 claude.ai 구독(Team/Pro 등)으로 Claude를 호출한다.
// window.claude.use('sample')이 주는 함수를 받는다. 시스템 프롬프트·도구 호출이 없으므로
// 지시는 프롬프트 앞에 붙이고, 인터뷰는 JSON 턴으로 진행한다.
import { INTERVIEWER_SYSTEM, buildInterviewOpening, INTERVIEW_JSON_FORMAT, INTERVIEW_REPLY_SCHEMA, INTERVIEW_FINISH_REQUEST, composePrompt, jsonFormatInstruction } from './prompts.js';
import { validateSchema } from './text.js';
import { AgentError } from './errors.js';
import { recordQuestion, recordFinish, applySave } from './interview.js';

export const SAMPLE_ERROR_TEXT = {
  not_granted: 'claude.ai가 이 페이지의 Claude 사용을 허용하지 않았습니다. 페이지를 새로 열어 허용해 주세요.',
  sampling_disabled: '이 계정(또는 조직)에서는 아티팩트 안에서 Claude를 사용할 수 없습니다.',
  not_declared: '이 페이지에 Claude 호출 권한이 선언되어 있지 않습니다. 다시 게시해야 합니다.',
  capability_disabled: '이 보기에서는 Claude 호출을 사용할 수 없습니다.',
  capability_removed: '이 뷰어 앱 버전에서는 지원되지 않는 기능입니다. 앱을 업데이트해 주세요.',
  rate_limited: 'Claude 사용량 한도에 걸렸습니다. 잠시 후 다시 시도해 주세요.',
  session_expired: 'claude.ai 로그인이 만료됐습니다. 다시 로그인해 주세요.',
  refused: 'Claude가 이 요청을 거절했습니다. 표현을 바꿔 다시 시도해 주세요.',
  empty_completion: 'Claude가 답을 내지 못했습니다. 입력을 줄이거나 다시 시도해 주세요.',
  invalid_json: '응답을 JSON으로 해석하지 못했습니다. 다시 시도해 주세요.',
  prompt_too_large: '보내는 내용이 너무 깁니다. 경험 카드나 공고 내용을 줄여 주세요.',
  upstream_error: '일시적인 오류입니다. 잠시 후 다시 시도해 주세요.',
  invalid_request: '요청 형식 오류입니다(페이지 버그). 새로고침 후 다시 시도해 주세요.',
  tools_unavailable: '이 보기에서는 도구 호출을 쓸 수 없습니다.',
};

function toAgentError(e) {
  if (e instanceof AgentError) return e;
  const code = e && typeof e === 'object' ? e.code : undefined;
  if (code === 'cancelled') return new AgentError('aborted', '중단했습니다.');
  if (code === 'refused') return new AgentError('refusal', SAMPLE_ERROR_TEXT.refused);
  if (code === 'invalid_json') return new AgentError('parse', SAMPLE_ERROR_TEXT.invalid_json, { detail: e.text ?? '' });
  if (code && SAMPLE_ERROR_TEXT[code]) return new AgentError(code, SAMPLE_ERROR_TEXT[code], { detail: e.message ?? '' });
  if (e instanceof Error) return e;
  return new AgentError('upstream_error', SAMPLE_ERROR_TEXT.upstream_error, { detail: e?.message ?? String(e) });
}

/** 스트리밍 중인 JSON 텍스트에서 question.question 값을 앞부분만이라도 뽑아낸다 */
export function peekQuestion(text) {
  const m = /"question"\s*:\s*\{[^{}]*?"question"\s*:\s*"((?:[^"\\]|\\.)*)/.exec(text ?? '');
  if (!m) return null;
  try { return JSON.parse(`"${m[1]}"`); } catch { return m[1]; }
}

/**
 * @param {Function} sample  claude.use('sample')의 결과 (sample(input, opts), sample.json(input, opts))
 */
export function createSampleProvider({ sample, cfg, onUsage }) {
  const tierFor = (role) => (role === 'writer' ? (cfg.tier || 'complex') : 'default');

  async function run(fn, { role, signal, onText, onRaw }) {
    const opts = { modelTier: tierFor(role), cache: false };
    if (signal) opts.signal = signal;
    if (onText || onRaw) {
      let prev = '';
      opts.onText = ({ text, delta }) => {
        try { onRaw?.(text); onText?.(delta ?? text.slice(prev.length), text); } catch (err) { console.error('handler error', err); }
        prev = text;
      };
    }
    try {
      const result = await fn(opts);
      try { onUsage?.({ model: `claude.ai/${result?.modelTierApplied ?? opts.modelTier}`, usage: null, message: null }); } catch (err) { console.error('usage handler error', err); }
      return result;
    } catch (e) {
      throw toAgentError(e);
    }
  }

  async function text({ system, user, role = 'writer', onText, signal }) {
    const prompt = composePrompt(system, user);
    const result = await run((opts) => sample(prompt, opts), { role, signal, onText });
    if (result?.truncated) throw new AgentError('max_tokens', '응답이 길이 제한에 걸려 잘렸습니다. 문항을 나누거나 다시 시도해 주세요.');
    return result.text;
  }

  async function json({ system, user, schema, role = 'critic', signal, label = '결과' }) {
    const prompt = composePrompt(system, user) + jsonFormatInstruction(schema);
    const parsed = await run((opts) => sample.json(prompt, opts), { role, signal });
    if (parsed === null || typeof parsed !== 'object') throw new AgentError('parse', `${label}(JSON)를 해석하지 못했습니다.`);
    return parsed;
  }

  // ───────────── 인터뷰 (JSON 턴 루프) ─────────────

  function openInterview(project) {
    return [{ role: 'user', content: `${INTERVIEWER_SYSTEM}\n\n${buildInterviewOpening(project)}\n\n${INTERVIEW_JSON_FORMAT}` }];
  }

  function pushUserTurn(iv, text) {
    const notes = (iv.pending?.results ?? []).filter((r) => typeof r === 'string');
    iv.messages.push({ role: 'user', content: `${notes.length ? `${notes.join('\n')}\n\n` : ''}[지원자 답변]\n${text}` });
  }

  function prepareResume(iv) {
    const last = iv.messages[iv.messages.length - 1];
    if (last && last.role === 'assistant') iv.messages.push({ role: 'user', content: '계속 진행하세요. 응답 형식대로 question 또는 finish를 채운 JSON만 출력하세요.' });
  }

  async function interviewStep(project, handlers = {}) {
    const iv = project.interview;
    for (let guard = 0; guard < 4; guard++) {
      let raw = '';
      const reply = await run((opts) => sample.json(iv.messages.map((m) => ({ role: m.role, content: m.content })), opts), {
        role: 'interviewer',
        signal: handlers.signal,
        onRaw: (t) => { raw = t; const q = peekQuestion(t); if (q) handlers.onQuestionDelta?.(q); },
      });
      iv.messages.push({ role: 'assistant', content: raw && raw.trim() ? raw : JSON.stringify(reply) });
      const errors = validateSchema(reply, INTERVIEW_REPLY_SCHEMA);
      if (errors.length) {
        iv.messages.push({ role: 'user', content: `형식 오류: ${errors.slice(0, 3).join(', ')}. 응답 형식의 JSON만 다시 출력하세요.` });
        continue;
      }
      const notes = [];
      for (const card of reply.saved ?? []) {
        const saved = applySave(project, card, handlers);
        notes.push(`저장됨: id=${saved.id} (${saved.title || '제목 없음'})`);
      }
      if (reply.finish) return recordFinish(iv, reply.finish);
      if (reply.question && reply.question.question) {
        return recordQuestion(iv, { toolUseId: null, results: notes, question: reply.question.question, why: reply.question.why ?? '', example: reply.question.example ?? '' });
      }
      iv.messages.push({ role: 'user', content: `${notes.join('\n')}\n\nquestion 또는 finish 중 하나를 반드시 채워 JSON만 다시 출력하세요.`.trim() });
    }
    throw new AgentError('loop', '인터뷰어가 질문이나 종료 없이 응답을 반복했습니다. 다시 시도해 주세요.');
  }

  return { kind: 'sample', text, json, openInterview, pushUserTurn, prepareResume, interviewStep, finishRequest: INTERVIEW_FINISH_REQUEST };
}
