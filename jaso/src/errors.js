export class AgentError extends Error {
  constructor(code, message, extra = {}) {
    super(message);
    this.name = 'AgentError';
    this.code = code;
    Object.assign(this, extra);
  }
}

/** 서버 측 안전 분류기 폴백(fallbacks: "default")을 지원하는 모델 */
export const FALLBACK_MODELS = new Set(['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-fable-5-1']);
