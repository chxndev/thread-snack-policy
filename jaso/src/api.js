// Anthropic SDK 래퍼: 브라우저 클라이언트 생성, 모델 카탈로그, 오류 문구, 비용 추정
import Anthropic from '@anthropic-ai/sdk';

export const MODELS = [
  { id: 'claude-opus-5-5', label: 'Claude Opus 5.5 (권장)', note: '품질·비용 균형', price: { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5 } },
  { id: 'claude-sonnet-5-5', label: 'Claude Sonnet 5.5', note: '빠르고 저렴', price: { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 } },
  { id: 'claude-fable-5-1', label: 'Claude Fable 5.1', note: '최고 성능, 고가', price: { input: 10, output: 50, cacheRead: 0.25, cacheWrite: 12.5 } },
];

/** USD per 1M tokens. 선택 가능한 모델 + 서버 측 폴백으로 응답할 수 있는 모델(추정 단가) */
const PRICES = {
  ...Object.fromEntries(MODELS.map((m) => [m.id, m.price])),
  'claude-opus-5': { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
  'claude-opus-4-8': { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
  'claude-opus-4-7': { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
  'claude-sonnet-5': { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 },
  'claude-haiku-4-5': { input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25 },
};

export const EFFORTS = [
  { id: 'medium', label: '표준 (medium)' },
  { id: 'high', label: '높음 (high)' },
  { id: 'xhigh', label: '최고 (xhigh)' },
];

export function createClient({ apiKey, baseURL }) {
  return new Anthropic({
    apiKey,
    baseURL: baseURL?.trim() ? baseURL.trim() : undefined,
    dangerouslyAllowBrowser: true, // 개인용 도구: 키는 사용자의 브라우저에서 API로 직접 전송된다
    maxRetries: 2,
    timeout: 10 * 60 * 1000,
  });
}

export const isApiError = (err) => err instanceof Anthropic.APIError;
export const isAbortError = (err) => err instanceof Anthropic.APIUserAbortError;
/** eager_input_streaming으로 받은 도구 입력 JSON을 SDK가 해석하지 못한 경우(이 경우만 재시도) */
export const isToolJsonError = (err) =>
  err instanceof Anthropic.AnthropicError && !(err instanceof Anthropic.APIError) && /Unable to parse tool parameter JSON/.test(err?.message ?? '');

/** 오류를 사용자에게 보여 줄 한국어 문구로 */
export function describeError(err) {
  if (!err) return '알 수 없는 오류';
  if (err.name === 'AgentError') return err.message;
  if (err instanceof Anthropic.APIUserAbortError) return '중단했습니다.';
  if (err instanceof Anthropic.AuthenticationError) return 'API 키가 올바르지 않습니다. 설정에서 키를 확인하세요.';
  if (err instanceof Anthropic.PermissionDeniedError) return '이 키로는 요청이 허용되지 않습니다(권한/결제 상태를 확인하세요).';
  if (err instanceof Anthropic.NotFoundError) return '모델을 찾을 수 없습니다. 설정에서 다른 모델을 선택하세요.';
  if (err instanceof Anthropic.RateLimitError) return '요청 한도에 걸렸습니다. 잠시 후 다시 시도하세요.';
  if (err instanceof Anthropic.BadRequestError) return `요청이 거부되었습니다: ${err.message}`;
  if (err instanceof Anthropic.InternalServerError) return 'API 서버 오류입니다. 잠시 후 다시 시도하세요.';
  if (err instanceof Anthropic.APIConnectionError) return '네트워크 오류로 API에 연결하지 못했습니다. 인터넷 연결(또는 Base URL)을 확인하세요.';
  if (err instanceof Anthropic.APIError) return `API 오류 (${err.status ?? '?'}): ${err.message}`;
  return err.message ?? String(err);
}

/** 토큰 수와 모델로 USD 비용 추정 (모르는 모델이면 null) */
export function estimateCost(modelId, totals) {
  const p = PRICES[modelId];
  if (!p) return null;
  return (totals.input * p.input + totals.output * p.output + totals.cacheRead * p.cacheRead + totals.cacheWrite * p.cacheWrite) / 1_000_000;
}

/**
 * 응답 메시지의 usage로 토큰·비용을 계산한다.
 * 서버 측 폴백이 있으면 usage.iterations(시도별 usage)가 과금 기준이므로 그것을 합산한다.
 */
export function costFromMessage(message, defaultModel) {
  const tok = (u) => ({
    input: u?.input_tokens ?? 0,
    output: u?.output_tokens ?? 0,
    cacheRead: u?.cache_read_input_tokens ?? 0,
    cacheWrite: u?.cache_creation_input_tokens ?? 0,
  });
  const entries = Array.isArray(message?.usage?.iterations) && message.usage.iterations.length
    ? message.usage.iterations.filter((it) => it && typeof it === 'object' && ('input_tokens' in it || 'output_tokens' in it)).map((it) => ({ model: it.model ?? message.model ?? defaultModel, tokens: tok(it) }))
    : [{ model: message?.model ?? defaultModel, tokens: tok(message?.usage) }];
  const total = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  let usd = 0;
  let unknown = false;
  for (const e of entries) {
    for (const k of Object.keys(total)) total[k] += e.tokens[k];
    const c = estimateCost(e.model, e.tokens);
    if (c === null) { unknown = true; usd += estimateCost(defaultModel, e.tokens) ?? 0; } else usd += c;
  }
  return { tokens: total, usd, unknownModel: unknown, fallbackRan: entries.some((e) => e.model !== defaultModel) };
}
