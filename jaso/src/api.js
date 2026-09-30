// 모델 카탈로그, 오류 문구, 비용 추정 (SDK 자체는 llm-sdk.js가 필요할 때만 불러온다)

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

/** claude.ai 아티팩트(sample) 모델 등급 */
export const TIERS = [
  { id: 'complex', label: '최고 (complex) — 가장 오래 생각, 작성 품질 최우선' },
  { id: 'default', label: '표준 (default) — 균형' },
  { id: 'quick', label: '빠름 (quick) — 생각 없이 바로 작성, 품질 낮음' },
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

/** 오류를 사용자에게 보여 줄 한국어 문구로 (SDK 전용 오류는 llm-sdk의 describeError가 먼저 처리) */
export function describeError(err, sdkDescribe = null) {
  if (!err) return '알 수 없는 오류';
  if (err.name === 'AgentError') return err.message;
  const fromSdk = sdkDescribe?.(err);
  if (fromSdk) return fromSdk;
  if (err.name === 'APIUserAbortError') return '중단했습니다.';
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
