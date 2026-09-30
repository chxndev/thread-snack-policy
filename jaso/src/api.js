// Anthropic SDK 래퍼: 브라우저 클라이언트 생성, 모델 카탈로그, 오류 문구, 비용 추정
import Anthropic from '@anthropic-ai/sdk';

export const MODELS = [
  { id: 'claude-opus-5-5', label: 'Claude Opus 5.5 (권장)', note: '품질·비용 균형', price: { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5 } },
  { id: 'claude-sonnet-5-5', label: 'Claude Sonnet 5.5', note: '빠르고 저렴', price: { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 } },
  { id: 'claude-fable-5-1', label: 'Claude Fable 5.1', note: '최고 성능, 고가', price: { input: 10, output: 50, cacheRead: 0.25, cacheWrite: 12.5 } },
];

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

/** usage 누적값으로 USD 비용 추정 */
export function estimateCost(modelId, totals) {
  const m = MODELS.find((x) => x.id === modelId);
  if (!m) return null;
  const p = m.price;
  const usd =
    (totals.input * p.input + totals.output * p.output + totals.cacheRead * p.cacheRead + totals.cacheWrite * p.cacheWrite) / 1_000_000;
  return usd;
}
