// Anthropic SDK 제공자: API 키로 api.anthropic.com을 직접 호출 (GitHub Pages 등 claude.ai 밖에서 실행할 때)
// SDK는 필요할 때만 동적으로 불러온다(아티팩트 환경에서는 로드하지 않음).
import { INTERVIEWER_SYSTEM, INTERVIEW_TOOLS, buildInterviewOpening, INTERVIEW_FINISH_REQUEST } from './prompts.js';
import { validateSchema } from './text.js';
import { AgentError, FALLBACK_MODELS } from './errors.js';
import { recordQuestion, recordFinish, applySave } from './interview.js';

const TOOL_SCHEMAS = Object.fromEntries(INTERVIEW_TOOLS.map((t) => [t.name, t.input_schema]));

export function textOf(message) {
  return (message?.content ?? []).filter((b) => b.type === 'text').map((b) => b.text).join('');
}

/**
 * 서버 측 폴백이 응답 도중 일어난 경우: 마지막 fallback 블록 앞의 thinking/tool_use 등 모델 내부 블록은
 * 실행하지도, 되돌려 보내지도 않는다(text 블록과 경계 이후 블록만 유지).
 */
export function stripPreFallback(content) {
  if (!Array.isArray(content)) return [];
  let last = -1;
  content.forEach((b, i) => { if (b?.type === 'fallback') last = i; });
  if (last < 0) return content;
  return content.filter((b, i) => (i > last ? true : b.type === 'text'));
}

let sdkPromise = null;
async function loadSdk() {
  sdkPromise ??= import('@anthropic-ai/sdk');
  return sdkPromise;
}

/** 브라우저에서 SDK 클라이언트를 만든다(동적 로드). */
export async function createSdkClient({ apiKey, baseURL }) {
  const { default: Anthropic } = await loadSdk();
  const client = new Anthropic({
    apiKey,
    baseURL: baseURL?.trim() ? baseURL.trim() : undefined,
    dangerouslyAllowBrowser: true, // 개인용 도구: 키는 사용자의 브라우저에서 API로 직접 전송된다
    maxRetries: 2,
    timeout: 10 * 60 * 1000,
  });
  return {
    client,
    isApiError: (err) => err instanceof Anthropic.APIError,
    isToolJsonError: (err) => err instanceof Anthropic.AnthropicError && !(err instanceof Anthropic.APIError) && /Unable to parse tool parameter JSON/.test(err?.message ?? ''),
    describeError: (err) => describeSdkError(Anthropic, err),
  };
}

function describeSdkError(Anthropic, err) {
  if (err instanceof Anthropic.APIUserAbortError) return '중단했습니다.';
  if (err instanceof Anthropic.AuthenticationError) return 'API 키가 올바르지 않습니다. 설정에서 키를 확인하세요.';
  if (err instanceof Anthropic.PermissionDeniedError) return '이 키로는 요청이 허용되지 않습니다(권한/결제 상태를 확인하세요).';
  if (err instanceof Anthropic.NotFoundError) return '모델을 찾을 수 없습니다. 설정에서 다른 모델을 선택하세요.';
  if (err instanceof Anthropic.RateLimitError) return '요청 한도에 걸렸습니다. 잠시 후 다시 시도하세요.';
  if (err instanceof Anthropic.BadRequestError) return `요청이 거부되었습니다: ${err.message}`;
  if (err instanceof Anthropic.InternalServerError) return 'API 서버 오류입니다. 잠시 후 다시 시도하세요.';
  if (err instanceof Anthropic.APIConnectionError) return '네트워크 오류로 API에 연결하지 못했습니다. 인터넷 연결(또는 Base URL)을 확인하세요.';
  if (err instanceof Anthropic.APIError) return `API 오류 (${err.status ?? '?'}): ${err.message}`;
  return null;
}

/**
 * SDK 제공자. client는 `client.beta.messages.stream(params)`를 제공해야 한다(테스트에서는 가짜 클라이언트).
 */
export function createSdkProvider({ client, cfg, onUsage, isApiError = () => false, isToolJsonError = () => false }) {
  const eager = !cfg.baseURL; // 프록시 경유 시 eager_input_streaming 생략

  function baseParams({ system, messages, maxTokens = 64000, effort = 'medium', tools, format, autoCache = false }) {
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

  // UI 콜백의 예외가 스트림 오류로 둔갑하지 않도록 감싼다
  const safe = (fn) => (...args) => { try { fn?.(...args); } catch (e) { console.error('handler error', e); } };

  async function call(params, handlers = {}) {
    let jsonRetries = 0;
    for (;;) {
      const stream = client.beta.messages.stream(params);
      const onAbort = () => stream.abort();
      handlers.signal?.addEventListener('abort', onAbort, { once: true });
      let currentTool = null;
      if (handlers.onText) stream.on('text', safe(handlers.onText));
      if (handlers.onToolJson) {
        stream.on('streamEvent', safe((ev) => {
          if (ev.type === 'content_block_start' && ev.content_block?.type === 'tool_use') currentTool = ev.content_block.name;
          if (ev.type === 'content_block_stop') currentTool = null;
        }));
        stream.on('inputJson', safe((_partial, snapshot) => handlers.onToolJson(currentTool, snapshot)));
      }
      try {
        const message = await stream.finalMessage();
        try { onUsage?.({ model: message.model, usage: message.usage, stopReason: message.stop_reason, message }); } catch (e) { console.error('usage handler error', e); }
        return message;
      } catch (err) {
        if (handlers.signal?.aborted) throw new AgentError('aborted', '중단했습니다.');
        // eager 스트리밍에서 SDK가 도구 입력 JSON을 해석하지 못한 경우만 재시도 (API 오류 등은 그대로 전달)
        if (params.tools && isToolJsonError(err) && jsonRetries++ < 2) continue;
        throw err;
      } finally {
        handlers.signal?.removeEventListener('abort', onAbort);
      }
    }
  }

  function checkStop(message, { toolTurn = false } = {}) {
    if (message.stop_reason === 'refusal') {
      throw new AgentError('refusal', '모델이 이 요청을 거절했습니다. 표현을 바꾸거나 다른 모델을 선택해 보세요.', { detail: message.stop_details?.explanation ?? '' });
    }
    if (message.stop_reason === 'max_tokens') {
      throw new AgentError('max_tokens', toolTurn
        ? '응답이 길이 제한(max_tokens)에 걸려 잘렸습니다. 다시 시도해 주세요.'
        : '응답이 길이 제한(max_tokens)에 걸려 잘렸습니다. 작성 품질(effort)을 낮추거나 다시 시도해 주세요.');
    }
  }

  /** 텍스트 생성(스트리밍) */
  async function text({ system, user, effort = 'medium', onText, signal }) {
    const message = await call(baseParams({ system, messages: [{ role: 'user', content: user }], effort }), { signal, onText });
    checkStop(message);
    return textOf(message);
  }

  /** 구조화 JSON 생성 */
  async function json({ system, user, schema, effort = 'medium', signal, label = '결과' }) {
    const message = await call(baseParams({ system, messages: [{ role: 'user', content: user }], effort, format: schema, maxTokens: 32000 }), { signal });
    checkStop(message);
    let parsed;
    try { parsed = JSON.parse(textOf(message)); } catch { throw new AgentError('parse', `${label}(JSON)를 해석하지 못했습니다.`); }
    return parsed;
  }

  // ───────────── 인터뷰 (tool use 루프) ─────────────

  function openInterview(project) {
    return [{ role: 'user', content: buildInterviewOpening(project) }];
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
  }

  function prepareResume(iv) {
    const last = iv.messages[iv.messages.length - 1];
    if (!last || last.role !== 'assistant') return;
    const unanswered = Array.isArray(last.content) && last.content.some((b) => b.type === 'tool_use');
    // tool_result 없이 끝난 도구 호출 턴은 되돌려 보낼 수 없으므로 버리고 다시 생성한다(그 앞 히스토리는 그대로)
    if (unanswered && iv.messages.length > 1) iv.messages.pop();
    else iv.messages.push({ role: 'user', content: '계속 진행하세요. ask_user로 질문하거나 finish_interview로 인터뷰를 마치세요.' });
  }

  async function interviewStep(project, handlers = {}) {
    const iv = project.interview;
    for (let guard = 0; guard < 6; guard++) {
      const params = baseParams({ system: INTERVIEWER_SYSTEM, messages: iv.messages, effort: 'medium', tools: INTERVIEW_TOOLS, maxTokens: 32000, autoCache: true });
      const message = await call(params, {
        signal: handlers.signal,
        onToolJson: (tool, snapshot) => {
          if (tool === 'ask_user' && snapshot && typeof snapshot.question === 'string') handlers.onQuestionDelta?.(snapshot.question);
        },
      });
      const content = stripPreFallback(message.content);
      const toolUses = content.filter((b) => b.type === 'tool_use');
      checkStop(message, { toolTurn: toolUses.length > 0 });
      iv.messages.push({ role: 'assistant', content }); // thinking 블록 포함, 그대로 되돌려 보낸다

      if (!toolUses.length) {
        const plain = textOf(message).trim();
        if (plain) return recordQuestion(iv, { question: plain }); // 도구 없이 텍스트로 물어본 경우: 질문으로 취급
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
          results.push({ type: 'tool_result', tool_use_id: tu.id, is_error: true, content: JSON.stringify({ INVALID_JSON: JSON.stringify(tu.input ?? null), errors }) });
          continue;
        }
        if (tu.name === 'save_experience') {
          const card = applySave(project, tu.input, handlers);
          results.push({ type: 'tool_result', tool_use_id: tu.id, content: `저장됨: id=${card.id}` });
        } else if (tu.name === 'finish_interview') {
          finished = tu.input;
          results.push({ type: 'tool_result', tool_use_id: tu.id, content: '인터뷰를 종료했습니다.' });
        } else if (tu.name === 'ask_user') {
          if (!ask) ask = { toolUseId: tu.id, ...tu.input };
          else results.push({ type: 'tool_result', tool_use_id: tu.id, content: '(한 턴에 질문은 하나만 할 수 있습니다. 이 질문은 다음 턴에 다시 하세요.)' });
        }
      }

      if (finished) {
        if (ask) results.push({ type: 'tool_result', tool_use_id: ask.toolUseId, content: '(인터뷰가 종료되어 이 질문은 생략합니다.)' });
        iv.messages.push({ role: 'user', content: results });
        return recordFinish(iv, finished);
      }
      if (ask) return recordQuestion(iv, { toolUseId: ask.toolUseId, results, question: ask.question, why: ask.why ?? '', example: ask.example ?? '' });
      iv.messages.push({ role: 'user', content: results }); // 저장만 한 턴: 결과를 돌려주고 계속
    }
    throw new AgentError('loop', '인터뷰어가 질문 없이 도구 호출만 반복했습니다. 다시 시도해 주세요.');
  }

  return { kind: 'sdk', text, json, openInterview, pushUserTurn, prepareResume, interviewStep, finishRequest: INTERVIEW_FINISH_REQUEST };
}
