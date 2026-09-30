import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createAgent, upsertExperience, currentText } from '../jaso/src/agent.js';
import { createSampleProvider, peekQuestion, SAMPLE_ERROR_TEXT } from '../jaso/src/llm-sample.js';
import { sampleProject } from './helpers/fake-client.js';

/** claude.use('sample') 흉내: responder(input, opts, kind) → string(text) | object(json) */
function fakeSample(responder) {
  const calls = [];
  const emit = async (opts, text) => { if (opts?.onText) { const mid = Math.max(1, Math.floor(text.length / 2)); opts.onText({ text: text.slice(0, mid), delta: text.slice(0, mid) }); opts.onText({ text, delta: text.slice(mid) }); } };
  const fn = async (input, opts = {}) => {
    calls.push({ input, opts, kind: 'text' });
    const out = await responder(input, opts, 'text');
    if (out && typeof out === 'object' && out.__error) throw out.__error;
    if (opts.signal?.aborted) throw { code: 'cancelled', message: 'cancelled' };
    await emit(opts, out);
    return { text: out, truncated: false, modelTierApplied: opts.modelTier ?? 'default' };
  };
  fn.json = async (input, opts = {}) => {
    calls.push({ input, opts, kind: 'json' });
    const out = await responder(input, opts, 'json');
    if (out && typeof out === 'object' && out.__error) throw out.__error;
    const text = typeof out === 'string' ? out : JSON.stringify(out);
    await emit(opts, text);
    try { return JSON.parse(text); } catch { throw { code: 'invalid_json', message: 'no json', text }; }
  };
  fn.calls = calls;
  return fn;
}

const cfg = { tier: 'complex', subheading: 'auto', maxRevisions: 2 };
const good = { scores: { fit: 5, specificity: 5, structure: 5, relevance: 5, style: 5, authenticity: 5 }, total: 100, needs_revision: false, must_fix: [], issues: [], strengths: ['a'], summary: 's' };

test('sample 인터뷰: JSON 턴으로 질문→저장→종료가 진행되고 히스토리는 user/assistant 문자열 턴이다', async () => {
  const project = sampleProject();
  let n = 0;
  const sample = fakeSample((input, opts, kind) => {
    assert.equal(kind, 'json');
    n++;
    assert.equal(opts.cache, false);
    assert.equal(opts.modelTier, 'default');
    if (n === 1) {
      assert.ok(Array.isArray(input) && input[0].role === 'user' && /응답 형식/.test(input[0].content) && /회사: 네이버/.test(input[0].content));
      return { saved: [], question: { question: '경험 후보를 알려 주세요.', why: '전체 파악', example: '' }, finish: null };
    }
    if (n === 2) {
      assert.match(input.at(-1).content, /\[지원자 답변\]\n캡스톤/);
      return { saved: [{ id: '', title: '캡스톤 성능 개선', situation: '2024', task: 't', action: 'a', result: '3초→0.4초', learned: 'l', keywords: ['성능'], question_ids: ['q1'] }], question: { question: '갈등은요?', why: '', example: '' }, finish: null };
    }
    assert.match(input.at(-1).content, /저장됨: id=exp_/, '저장 결과가 다음 턴에 전달됨');
    return { saved: [{ id: project.experiences[0].id, title: '', situation: '', task: '', action: '회의 도입', result: '', learned: '', keywords: [], question_ids: ['q1', 'q2'] }], question: null, finish: { summary: '요약', writer_notes: '메모' } };
  });
  const deltas = [];
  const agent = createAgent({ provider: createSampleProvider({ sample, cfg }), settings: cfg });
  const r1 = await agent.interviewStart(project, { onQuestionDelta: (q) => deltas.push(q) });
  assert.equal(r1.type, 'question');
  assert.equal(project.interview.pending.question, '경험 후보를 알려 주세요.');
  assert.ok(deltas.length >= 1 && deltas.at(-1) === '경험 후보를 알려 주세요.');
  assert.equal(project.interview.messages.length, 2);
  assert.equal(project.interview.messages[1].role, 'assistant');
  const r2 = await agent.interviewAnswer(project, '캡스톤 프로젝트요', {});
  assert.equal(r2.type, 'question');
  assert.equal(project.experiences.length, 1);
  const r3 = await agent.interviewAnswer(project, '의견 충돌', {});
  assert.equal(r3.type, 'done');
  assert.equal(project.interview.summary, '요약');
  assert.equal(project.experiences[0].action, '회의 도입');
  assert.deepEqual(project.experiences[0].questionIds, ['q1', 'q2']);
  for (const m of project.interview.messages) assert.equal(typeof m.content, 'string');
});

test('sample 인터뷰: 형식이 틀리면 한 번 더 요청하고, question/finish가 모두 비면 재요청한다', async () => {
  const project = sampleProject();
  let n = 0;
  const sample = fakeSample(() => {
    n++;
    if (n === 1) return { saved: 'nope' };
    if (n === 2) return { saved: [], question: null, finish: null };
    return { saved: [], question: null, finish: { summary: 's', writer_notes: '' } };
  });
  const agent = createAgent({ provider: createSampleProvider({ sample, cfg }), settings: cfg });
  const r = await agent.interviewStart(project, {});
  assert.equal(r.type, 'done');
  assert.equal(n, 3);
  assert.match(project.interview.messages[2].content, /형식 오류/);
});

test('sample 인터뷰 강제 종료·재개', async () => {
  const project = sampleProject();
  let n = 0;
  const sample = fakeSample(() => {
    n++;
    if (n === 1) return { saved: [], question: { question: 'q1', why: '', example: '' }, finish: null };
    return { saved: [], question: null, finish: { summary: 's', writer_notes: '' } };
  });
  const agent = createAgent({ provider: createSampleProvider({ sample, cfg }), settings: cfg });
  await agent.interviewStart(project, {});
  const r = await agent.interviewFinish(project, {});
  assert.equal(r.type, 'done');
  assert.match(sample.calls[1].input.at(-1).content, /마치길 원합니다/);
  // 재개: 마지막이 assistant면 '계속' 턴을 붙인다
  const p2 = sampleProject();
  p2.interview = { ...p2.interview, status: 'idle', messages: [{ role: 'user', content: 'x' }, { role: 'assistant', content: '{}' }] };
  await agent.interviewResume(p2, {});
  assert.match(sample.calls[2].input.at(-1).content, /계속 진행하세요/);
});

test('sample 작성 파이프라인: 시스템 프롬프트가 프롬프트 앞에 붙고, 작성은 complex, 첨삭은 default 등급', async () => {
  const project = sampleProject();
  upsertExperience(project, { id: '', title: 'A', situation: 's', task: 't', action: 'a', result: 'r', learned: 'l', keywords: [], question_ids: ['q1'] }, 'manual');
  const sample = fakeSample((input, opts, kind) => {
    if (kind === 'json') { assert.match(input, /\[출력 형식\]/); assert.match(input, /"additionalProperties":false/); return good; }
    assert.match(input, /^\[역할과 규칙\]\n당신은 한국 기업 채용 자기소개서/);
    assert.match(input, /\[요청\]\n\[지원 정보\]/);
    return '```\n초안 본문 ' + '가'.repeat(460) + '\n```';
  });
  const streamed = [];
  const agent = createAgent({ provider: createSampleProvider({ sample, cfg }), settings: cfg });
  const ans = await agent.complete(project, project.questions[0], { onText: (d, s) => streamed.push(s) });
  assert.equal(ans.status, 'done');
  assert.ok(currentText(ans).startsWith('초안 본문'), '코드펜스 제거');
  assert.equal(sample.calls[0].opts.modelTier, 'complex');
  assert.equal(sample.calls[1].opts.modelTier, 'default');
  assert.ok(streamed.length >= 2);
});

test('sample 오류 매핑: cancelled→aborted, not_granted 문구, truncated→max_tokens, invalid_json→parse', async () => {
  const project = sampleProject();
  const errSample = (code) => fakeSample(() => ({ __error: { code, message: code } }));
  const mk = (s) => createAgent({ provider: createSampleProvider({ sample: s, cfg }), settings: cfg });
  await assert.rejects(() => mk(errSample('cancelled')).draft(project, project.questions[0], {}), (e) => e.code === 'aborted');
  await assert.rejects(() => mk(errSample('not_granted')).draft(project, project.questions[0], {}), (e) => e.code === 'not_granted' && e.message === SAMPLE_ERROR_TEXT.not_granted);
  await assert.rejects(() => mk(errSample('invalid_json')).critique(project, project.questions[0], 'x'), (e) => e.code === 'parse');
  const trunc = fakeSample(() => '잘림');
  const origFn = trunc; // truncated 플래그를 흉내
  const wrapped = Object.assign(async (i, o) => ({ ...(await origFn(i, o)), truncated: true }), { json: trunc.json, calls: trunc.calls });
  await assert.rejects(() => mk(wrapped).draft(project, project.questions[0], {}), (e) => e.code === 'max_tokens');
});

test('peekQuestion은 스트리밍 중인 JSON에서 질문 앞부분을 뽑는다', () => {
  assert.equal(peekQuestion('{"saved":[],"question":{"question":"안녕하세요, 어떤 경'), '안녕하세요, 어떤 경');
  assert.equal(peekQuestion('{"saved":[],"question":{"question":"따옴표 \\"포함\\" 질문","why"'), '따옴표 "포함" 질문');
  assert.equal(peekQuestion('{"saved":[]'), null);
});
