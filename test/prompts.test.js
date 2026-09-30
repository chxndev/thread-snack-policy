import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildInterviewOpening, buildDraftRequest, buildCritiqueRequest, buildLengthFixRequest, buildSelectionEditRequest,
  buildReviseRequest, buildEditRequest, interviewBudget,
  formatProfile, INTERVIEW_TOOLS, CRITIQUE_SCHEMA, JD_SCHEMA, INTERVIEW_PREP_SCHEMA, computeTotal, JD_ANALYST_SYSTEM,
} from '../jaso/src/prompts.js';
import { validateSchema } from '../jaso/src/text.js';
import { sampleProject } from './helpers/fake-client.js';

test('도구 스키마는 strict 요건(additionalProperties:false, required 포함)을 만족한다', () => {
  for (const t of INTERVIEW_TOOLS) {
    assert.equal(t.strict, true);
    assert.equal(t.input_schema.additionalProperties, false);
    assert.deepEqual([...t.input_schema.required].sort(), Object.keys(t.input_schema.properties).sort());
  }
});

test('구조화 출력 스키마는 모든 객체에 additionalProperties:false를 가진다', () => {
  const walk = (schema, path = '$') => {
    if (schema.type === 'object') {
      assert.equal(schema.additionalProperties, false, `${path} additionalProperties`);
      assert.deepEqual([...schema.required].sort(), Object.keys(schema.properties).sort(), `${path} required`);
      for (const [k, v] of Object.entries(schema.properties)) walk(v, `${path}.${k}`);
    }
    if (schema.type === 'array') walk(schema.items, `${path}[]`);
    for (const key of ['minimum', 'maximum', 'minLength', 'maxLength']) assert.ok(!(key in schema), `${path} ${key} 미지원`);
  };
  walk(CRITIQUE_SCHEMA); walk(JD_SCHEMA); walk(INTERVIEW_PREP_SCHEMA);
});

test('인터뷰 시작 메시지에 지원 정보·문항·글자수 기준이 들어간다', () => {
  const p = sampleProject();
  p.profile.jdSummary = { competencies: ['Spring', 'MSA'], talent: '도전', notes: '기술 깊이' };
  const s = buildInterviewOpening(p);
  assert.match(s, /회사: 네이버/);
  assert.match(s, /q1\. \[제한 500자 \(공백 포함\), 유형: 지원동기\]/);
  assert.match(s, /요구 역량 키워드: Spring, MSA/);
  assert.match(s, /ask_user로 첫 질문/);
});

test('초안 요청에 목표 글자수·연관 카드 표시·다른 문항 답변이 포함된다', () => {
  const p = sampleProject();
  p.experiences.push({ id: 'exp1', title: 'A', situation: 's', task: 't', action: 'a', result: 'r', learned: 'l', keywords: ['k'], questionIds: ['q2'] });
  const s = buildDraftRequest(p, p.questions[1], { otherAnswers: [{ id: 'q1', questionText: '지원 동기', text: '이미 쓴 글' }], subheading: 'on' });
  assert.match(s, /목표 900~960자/);
  assert.match(s, /절대 1000자를 넘기지/);
  assert.match(s, /★이 문항 연관/);
  assert.match(s, /소제목: 사용/);
  assert.match(s, /이미 쓴 글/);
});

test('글자수 조정 요청은 초과·부족 방향을 정확히 지시하고 지원 정보(블라인드 포함)를 싣는다', () => {
  const p = sampleProject();
  p.profile.blind = true;
  const q = p.questions[0]; // 500자
  assert.match(buildLengthFixRequest(p, q, '가'.repeat(560)), /80자 이상 줄여서 450~480자/);
  assert.match(buildLengthFixRequest(p, q, '가'.repeat(400)), /50자 이상 늘려서 450~480자/);
  assert.match(buildLengthFixRequest(p, q, '가'.repeat(400)), /블라인드 채용/);
  assert.match(buildSelectionEditRequest(p, q, '첫 문장. 둘째 문장.', '둘째 문장.', 'x'), /블라인드 채용/);
});

test('첨삭 요청에 글자수 판정·문항 유형·소제목 정책이 들어간다', () => {
  const p = sampleProject();
  const s = buildCritiqueRequest(p, p.questions[0], '가'.repeat(520), { subheading: 'on' });
  assert.match(s, /20자 초과/);
  assert.match(s, /must_fix에 넣지 말고/);
  assert.match(s, /문항 유형: 지원동기/);
  assert.match(s, /삭제 권고 금지/);
  assert.match(buildCritiqueRequest(p, p.questions[0], '본문', { subheading: 'off' }), /소제목 제거/);
});

test('수정 요청에 다른 문항 답변·인터뷰 요약이 들어가고 글자수 문구가 한 기준으로 통일된다', () => {
  const p = sampleProject();
  p.interview.summary = '요약입니다';
  const crit = { summary: 's', total: 70, must_fix: ['x'], issues: [], strengths: [] };
  const s = buildReviseRequest(p, p.questions[1], '가'.repeat(985), crit, { subheading: 'on', otherAnswers: [{ id: 'q1', questionText: '지원 동기', text: '다른 답변' }] });
  assert.match(s, /다른 답변/);
  assert.match(s, /\[인터뷰 요약\]\n요약입니다/);
  assert.match(s, /목표 900~960자/);
  assert.match(s, /현재 글자수: 985자 \/ 제한 1000자 \(공백 포함\) — 범위 내\(상한에 가까움/);
  assert.ok(!/목표 900~1000자/.test(s), '판정용 범위(90~100%)가 섞이지 않음');
});

test('편집 요청은 상한만 강제하고, 공백 제외 모드는 줄바꿈 미포함으로 안내한다', () => {
  const p = sampleProject();
  const s = buildEditRequest(p, p.questions[0], '본문', '더 간결하게');
  assert.match(s, /절대 500자를 넘기지 마세요/);
  assert.match(s, /분량을 줄이는 것이 아니라면 450자 이상/);
  const q = { ...p.questions[0], mode: 'without' };
  assert.match(buildDraftRequest(p, q), /공백·줄바꿈은 세지 않고/);
  const noLimit = { ...p.questions[0], limit: 0 };
  assert.match(buildDraftRequest(p, noLimit, { subheading: 'auto' }), /제한 없음 → 800~1000자/);
});

test('인터뷰 질문 예산은 문항 수에 비례한다', () => {
  assert.equal(interviewBudget([]), 6);
  assert.equal(interviewBudget(new Array(4)), 10);
  assert.equal(interviewBudget(new Array(12)), 20);
  assert.match(buildInterviewOpening(sampleProject()), /질문 예산: 약 6개/);
});

test('부분 수정 요청은 선택 구간과 요청을 포함한다', () => {
  const p = sampleProject();
  const s = buildSelectionEditRequest(p, p.questions[0], '첫 문장. 둘째 문장.', '둘째 문장.', '더 구체적으로');
  assert.match(s, /\[수정할 구간[^\]]*\]\n둘째 문장\./);
  assert.match(s, /더 구체적으로/);
});

test('formatProfile은 빈 항목을 생략한다', () => {
  const s = formatProfile({ company: 'A', role: 'B', level: 'exp', jobPosting: '', background: '', notes: '', jdSummary: null });
  assert.equal(s, '회사: A\n직무: B\n구분: 경력');
});

test('computeTotal 가중 합산과 스키마 검증 조합', () => {
  const crit = { scores: { fit: 5, specificity: 5, structure: 5, relevance: 5, style: 5, authenticity: 5 }, total: 0, needs_revision: false, must_fix: [], issues: [], strengths: [], summary: '' };
  assert.deepEqual(validateSchema(crit, CRITIQUE_SCHEMA), []);
  assert.equal(computeTotal(crit.scores), 100);
  assert.equal(computeTotal({}), 0);
});

test('블라인드 채용·회사 정보 입력이 프로필에 반영된다', () => {
  const s = formatProfile({ company: 'LH', role: '사무', level: 'new', jobPosting: '', background: '', companyFacts: '3기 신도시 사업', notes: '', jdSummary: null, blind: true });
  assert.match(s, /3기 신도시 사업/);
  assert.match(s, /블라인드 채용: 출신 학교명/);
});

test('JD 분석가 프롬프트가 type/mode 값을 설명한다', () => {
  assert.match(JD_ANALYST_SYSTEM, /motivation=지원동기/);
  assert.match(JD_ANALYST_SYSTEM, /bytes2=바이트/);
});
