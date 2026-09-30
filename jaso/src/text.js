// 글자수·텍스트 유틸리티 (순수 함수, DOM 의존 없음)

/** CRLF/CR → LF 정규화 */
export function normalizeNewlines(text) {
  return String(text ?? '').replace(/\r\n?/g, '\n');
}

/** 공백 포함 글자수: 코드포인트 기준, 줄바꿈은 1자로 센다 */
export function countWithSpaces(text) {
  return Array.from(normalizeNewlines(text)).length;
}

/** 공백 제외 글자수: 모든 공백 문자(스페이스·탭·줄바꿈)를 뺀 코드포인트 수 */
export function countWithoutSpaces(text) {
  return Array.from(normalizeNewlines(text).replace(/\s/g, '')).length;
}

/** 바이트 수(한글 2바이트 방식): 비ASCII 2바이트, ASCII 1바이트, 줄바꿈 1바이트 */
export function countBytes2(text) {
  let n = 0;
  for (const ch of normalizeNewlines(text)) {
    n += ch.codePointAt(0) > 0x7f ? 2 : 1;
  }
  return n;
}

export const COUNT_MODES = {
  with: { label: '공백 포함', unit: '자', count: countWithSpaces },
  without: { label: '공백 제외', unit: '자', count: countWithoutSpaces },
  bytes2: { label: '바이트(한글 2byte)', unit: 'byte', count: countBytes2 },
};

export function countBy(mode, text) {
  const m = COUNT_MODES[mode] ?? COUNT_MODES.with;
  return m.count(text);
}

/** 글자수 제한에 대한 목표 범위. 기본 90%~100%. */
export function targetRange(limit, { minRatio = 0.9 } = {}) {
  const max = Math.max(0, Math.floor(Number(limit) || 0));
  if (!max) return { min: 0, max: 0 };
  return { min: Math.floor(max * minRatio), max };
}

/**
 * 글자수 판정.
 * @returns {{count:number, min:number, max:number, status:'ok'|'over'|'under'|'none', diff:number}}
 *  diff: 양수면 초과분, 음수면 부족분(min 기준), 0이면 범위 내
 */
export function judgeLength(text, limit, mode = 'with', opts = {}) {
  const count = countBy(mode, text);
  const { min, max } = targetRange(limit, opts);
  if (!max) return { count, min: 0, max: 0, status: 'none', diff: 0 };
  if (count > max) return { count, min, max, status: 'over', diff: count - max };
  if (count < min) return { count, min, max, status: 'under', diff: count - min };
  return { count, min, max, status: 'ok', diff: 0 };
}

/** 사람이 읽는 글자수 안내 문구 (프롬프트·UI 공용) */
export function describeLength(judge, mode = 'with') {
  const m = COUNT_MODES[mode] ?? COUNT_MODES.with;
  if (judge.status === 'none') return `${judge.count}${m.unit} (${m.label}, 제한 없음)`;
  const base = `${judge.count}${m.unit} / 제한 ${judge.max}${m.unit} (${m.label}, 목표 ${judge.min}~${judge.max}${m.unit})`;
  if (judge.status === 'over') return `${base} — ${judge.diff}${m.unit} 초과`;
  if (judge.status === 'under') return `${base} — ${-judge.diff}${m.unit} 부족`;
  return `${base} — 범위 내`;
}

/** 문장 수·평균 문장 길이(공백 포함 글자) 등 간단 통계 */
export function textStats(text) {
  const t = normalizeNewlines(text).trim();
  if (!t) return { sentences: 0, avgSentenceLen: 0, paragraphs: 0, longSentences: 0 };
  const sentences = t
    .split(/(?<=[.!?。])\s+|\n+/)
    .map((s) => s.trim())
    .filter(Boolean);
  const lens = sentences.map((s) => Array.from(s).length);
  const avg = lens.reduce((a, b) => a + b, 0) / (lens.length || 1);
  const paragraphs = t.split(/\n+/).filter((p) => p.trim()).length;
  return {
    sentences: sentences.length,
    avgSentenceLen: Math.round(avg),
    paragraphs,
    longSentences: lens.filter((l) => l > 80).length,
  };
}

/** 모델 출력에서 코드펜스·앞 라벨 등 흔한 군더더기 제거 */
export function cleanModelText(text) {
  let t = normalizeNewlines(text).trim();
  t = t.replace(/^```[a-z]*\n?/i, '').replace(/\n?```$/i, '').trim();
  t = t.replace(/^(답변|자기소개서|자소서|초안)\s*[:：]\s*\n?/i, '').trim();
  return t;
}

/** 간단한 JSON 스키마 검사기: 도구 입력·구조화 출력 검증용 */
export function validateSchema(value, schema, path = '$') {
  const errors = [];
  const type = schema?.type;
  const typeOk = (v, t) => {
    switch (t) {
      case 'object': return v !== null && typeof v === 'object' && !Array.isArray(v);
      case 'array': return Array.isArray(v);
      case 'string': return typeof v === 'string';
      case 'number': return typeof v === 'number' && Number.isFinite(v);
      case 'integer': return Number.isInteger(v);
      case 'boolean': return typeof v === 'boolean';
      case 'null': return v === null;
      default: return true;
    }
  };
  if (type) {
    const types = Array.isArray(type) ? type : [type];
    if (!types.some((t) => typeOk(value, t))) {
      errors.push(`${path}: expected ${types.join('|')}`);
      return errors;
    }
  }
  if (schema?.enum && !schema.enum.includes(value)) {
    errors.push(`${path}: not in enum`);
  }
  if (type === 'object' && schema.properties) {
    for (const key of schema.required ?? []) {
      if (!(key in value)) errors.push(`${path}.${key}: required`);
    }
    for (const [key, sub] of Object.entries(schema.properties)) {
      if (key in value) errors.push(...validateSchema(value[key], sub, `${path}.${key}`));
    }
    if (schema.additionalProperties === false) {
      for (const key of Object.keys(value)) {
        if (!(key in schema.properties)) errors.push(`${path}.${key}: unexpected`);
      }
    }
  }
  if (type === 'array' && schema.items) {
    value.forEach((v, i) => errors.push(...validateSchema(v, schema.items, `${path}[${i}]`)));
  }
  return errors;
}

export function uid(prefix = 'id') {
  const rand = Math.random().toString(36).slice(2, 8);
  return `${prefix}_${Date.now().toString(36)}${rand}`;
}
